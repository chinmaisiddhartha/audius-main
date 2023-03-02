import concurrent.futures
import datetime
import json
import logging
import time
from decimal import Decimal
from typing import Any, List, Optional, Set, TypedDict

import base58
from redis import Redis
from solana.publickey import PublicKey
from src.exceptions import UnsupportedVersionError
from src.models.indexing.spl_token_transaction import SPLTokenTransaction
from src.models.users.associated_wallet import AssociatedWallet, WalletChain
from src.models.users.audio_transactions_history import (
    AudioTransactionsHistory,
    TransactionMethod,
    TransactionType,
)
from src.models.users.user import User
from src.models.users.user_bank import UserBankAccount
from src.queries.get_balances import enqueue_immediate_balance_refresh
from src.solana.constants import (
    FETCH_TX_SIGNATURES_BATCH_SIZE,
    TX_SIGNATURES_MAX_BATCHES,
    TX_SIGNATURES_RESIZE_LENGTH,
)
from src.solana.solana_client_manager import SolanaClientManager
from src.solana.solana_helpers import SPL_TOKEN_ID, get_base_address
from src.solana.solana_transaction_types import (
    ConfirmedSignatureForAddressResult,
    ConfirmedTransaction,
)
from src.tasks.celery_app import celery
from src.utils.cache_solana_program import (
    CachedProgramTxInfo,
    cache_latest_sol_db_tx,
    fetch_and_cache_latest_program_tx_redis,
)
from src.utils.config import shared_config
from src.utils.helpers import (
    get_account_index,
    get_solana_tx_owner,
    get_solana_tx_token_balances,
    get_valid_instruction,
    has_log,
)
from src.utils.prometheus_metric import save_duration_metric
from src.utils.redis_constants import (
    latest_sol_spl_token_db_key,
    latest_sol_spl_token_program_tx_key,
)
from src.utils.session_manager import SessionManager
from src.utils.solana_indexing_logger import SolanaIndexingLogger

SPL_TOKEN_PROGRAM = shared_config["solana"]["waudio_mint"]
SPL_TOKEN_PUBKEY = PublicKey(SPL_TOKEN_PROGRAM) if SPL_TOKEN_PROGRAM else None
USER_BANK_ADDRESS = shared_config["solana"]["user_bank_program_address"]
USER_BANK_PUBKEY = PublicKey(USER_BANK_ADDRESS) if USER_BANK_ADDRESS else None
PURCHASE_AUDIO_MEMO_PROGRAM = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"
TRANSFER_CHECKED_INSTRUCTION = "Program log: Instruction: TransferChecked"

REDIS_TX_CACHE_QUEUE_PREFIX = "spl-token-tx-cache-queue"

# Number of signatures that are fetched from RPC and written at once
# For example, in a batch of 1000 only 100 will be fetched and written in parallel
# Intended to relieve RPC and DB pressure
TX_SIGNATURES_PROCESSING_SIZE = 100

# Index of memo instruction in instructions list
MEMO_INSTRUCTION_INDEX = 4
# Index of receiver account in solana transaction pre/post balances
# Note: the receiver index is currently the same for purchase and transfer instructions
# but this assumption could change in the future.
RECEIVER_ACCOUNT_INDEX = 2
# Though we don't index transfers from the sender's side in this task, we must still
# enqueue the sender's accounts for balance refreshes if they are Audius accounts.
SENDER_ACCOUNT_INDEX = 0
INITIAL_FETCH_SIZE = 10

purchase_vendor_map = {
    "Link by Stripe": TransactionType.purchase_stripe,
    "Coinbase Pay": TransactionType.purchase_coinbase,
    "Unknown": TransactionType.purchase_unknown,
}

logger = logging.getLogger(__name__)


class SplTokenTransactionInfo(TypedDict):
    user_bank: str
    signature: str
    slot: int
    timestamp: datetime.datetime
    vendor: Optional[str]
    prebalance: int
    postbalance: int
    sender_wallet: str
    root_accounts: List[str]
    token_accounts: List[str]


# Cache the latest value committed to DB in redis
# Used for quick retrieval in health check
def cache_latest_spl_audio_db_tx(redis: Redis, latest_tx: CachedProgramTxInfo):
    cache_latest_sol_db_tx(redis, latest_sol_spl_token_db_key, latest_tx)


def parse_memo_instruction(result: Any) -> str:
    try:
        txs = result["transaction"]
        memo_instruction = next(
            (
                inst
                for inst in txs["message"]["instructions"]
                if inst["programIdIndex"] == MEMO_INSTRUCTION_INDEX
            ),
            None,
        )
        if not memo_instruction:
            return ""

        memo_account = txs["message"]["accountKeys"][MEMO_INSTRUCTION_INDEX]
        if not memo_account or memo_account != PURCHASE_AUDIO_MEMO_PROGRAM:
            return ""
        return memo_instruction["data"]
    except Exception as e:
        logger.error(f"index_spl_token.py | Error parsing memo, {e}", exc_info=True)
        raise e


def decode_memo_and_extract_vendor(memo_encoded: str) -> str:
    try:
        memo = str(base58.b58decode(memo_encoded))
        if not memo or "In-App $AUDIO Purchase:" not in memo:
            return ""

        vendor = memo[1:-1].split(":")[1][1:]
        if vendor not in purchase_vendor_map:
            return ""
        return vendor
    except Exception as e:
        logger.error(f"index_spl_token.py | Error decoding memo, {e}", exc_info=True)
        raise e


def parse_spl_token_transaction(
    solana_client_manager: SolanaClientManager,
    tx_sig: ConfirmedSignatureForAddressResult,
) -> Optional[SplTokenTransactionInfo]:
    try:
        tx_info = solana_client_manager.get_sol_tx_info(tx_sig["signature"])
        result = tx_info["result"]
        meta = result["meta"]
        error = meta["err"]
        if error:
            return None

        has_transfer_checked_instruction = has_log(meta, TRANSFER_CHECKED_INSTRUCTION)
        if not has_transfer_checked_instruction:
            logger.debug(
                f"index_spl_token.py | {tx_sig} No transfer checked instruction found"
            )
            return None
        tx_message = result["transaction"]["message"]
        instruction = get_valid_instruction(tx_message, meta, SPL_TOKEN_ID)
        if not instruction:
            logger.error(
                f"index_spl_token.py | {tx_sig} No valid instruction for spl token program found"
            )
            return None

        memo_encoded = parse_memo_instruction(result)
        vendor = decode_memo_and_extract_vendor(memo_encoded) if memo_encoded else None

        sender_idx = get_account_index(instruction, SENDER_ACCOUNT_INDEX)
        receiver_idx = get_account_index(instruction, RECEIVER_ACCOUNT_INDEX)
        account_keys = tx_message["accountKeys"]
        sender_token_account = account_keys[sender_idx]
        receiver_token_account = account_keys[receiver_idx]
        sender_root_account = get_solana_tx_owner(meta, sender_idx)
        receiver_root_account = get_solana_tx_owner(meta, receiver_idx)
        prebalance, postbalance = get_solana_tx_token_balances(meta, receiver_idx)

        # Balance is expected to change if there is a transfer instruction.
        if postbalance == -1 or prebalance == -1:
            logger.error(
                f"index_spl_token.py | {tx_sig} error while parsing pre and post balances"
            )
            return None
        if postbalance - prebalance == 0:
            logger.error(f"index_spl_token.py | {tx_sig} no balance change found")
            return None

        receiver_spl_tx_info: SplTokenTransactionInfo = {
            "user_bank": receiver_token_account,
            "signature": tx_sig["signature"],
            "slot": result["slot"],
            "timestamp": datetime.datetime.utcfromtimestamp(result["blockTime"]),
            "vendor": vendor,
            "prebalance": prebalance,
            "postbalance": postbalance,
            "sender_wallet": sender_root_account,
            "root_accounts": [sender_root_account, receiver_root_account],
            "token_accounts": [sender_token_account, receiver_token_account],
        }
        return receiver_spl_tx_info

    except UnsupportedVersionError:
        return None
    except Exception as e:
        signature = tx_sig["signature"]
        logger.error(
            f"index_spl_token.py | Error processing {signature}, {e}", exc_info=True
        )
        raise e


def process_spl_token_transactions(
    txs: List[SplTokenTransactionInfo], user_bank_set: Set[str]
) -> List[AudioTransactionsHistory]:
    try:
        audio_txs = []
        for tx_info in txs:
            # Disregard if recipient account is not a user_bank
            if tx_info["user_bank"] not in user_bank_set:
                continue

            logger.info(
                f"index_spl_token.py | processing transaction: {tx_info['signature']} | slot={tx_info['slot']}"
            )
            vendor = tx_info["vendor"]
            # Index as an external receive transaction
            # Note: external sends are under a different program, see index_user_bank.py
            if not vendor:
                audio_txs.append(
                    AudioTransactionsHistory(
                        user_bank=tx_info["user_bank"],
                        slot=tx_info["slot"],
                        signature=tx_info["signature"],
                        transaction_type=(TransactionType.transfer),
                        method=TransactionMethod.receive,
                        transaction_created_at=tx_info["timestamp"],
                        change=Decimal(tx_info["postbalance"] - tx_info["prebalance"]),
                        balance=Decimal(tx_info["postbalance"]),
                        tx_metadata=tx_info["sender_wallet"],
                    )
                )
            # Index as purchase transaction
            else:
                audio_txs.append(
                    AudioTransactionsHistory(
                        user_bank=tx_info["user_bank"],
                        slot=tx_info["slot"],
                        signature=tx_info["signature"],
                        transaction_type=purchase_vendor_map[vendor],
                        method=TransactionMethod.receive,
                        transaction_created_at=tx_info["timestamp"],
                        change=Decimal(tx_info["postbalance"] - tx_info["prebalance"]),
                        balance=Decimal(tx_info["postbalance"]),
                        tx_metadata=None,
                    )
                )
        return audio_txs

    except Exception as e:
        logger.error(
            f"index_spl_token.py | Error processing transaction {tx_info}, {e}",
            exc_info=True,
        )
        raise e


# Query the highest traversed solana slot
def get_latest_slot(db):
    latest_slot = None
    with db.scoped_session() as session:
        highest_slot_query = session.query(
            SPLTokenTransaction.last_scanned_slot
        ).first()
        # Can be None prior to first write operations
        if highest_slot_query is not None:
            latest_slot = highest_slot_query[0]

    # Return None if not yet cached
    return latest_slot


def parse_sol_tx_batch(
    db: SessionManager,
    solana_client_manager: SolanaClientManager,
    redis: Redis,
    tx_sig_batch_records: List[ConfirmedSignatureForAddressResult],
    solana_logger: SolanaIndexingLogger,
):
    """
    Parse a batch of solana transactions in parallel by calling parse_spl_token_transaction
    with a ThreaPoolExecutor

    This function also has a recursive retry upto a certain limit in case a future doesn't complete
    within the alloted time. It clears the futures thread queue and the batch is retried
    """
    batch_start_time = time.time()
    # Last record in this batch to be cached
    # Important to note that the batch records are in time DESC order
    updated_root_accounts: Set[str] = set()
    updated_token_accounts: Set[str] = set()
    spl_token_txs: List[ConfirmedTransaction] = []
    # Process each batch in parallel
    with concurrent.futures.ThreadPoolExecutor() as executor:
        parse_sol_tx_futures = {
            executor.submit(
                parse_spl_token_transaction,
                solana_client_manager,
                tx_sig,
            ): tx_sig
            for tx_sig in tx_sig_batch_records
        }
        try:
            for future in concurrent.futures.as_completed(
                parse_sol_tx_futures, timeout=45
            ):
                tx_info = future.result()
                if not tx_info:
                    continue
                updated_root_accounts.update(tx_info["root_accounts"])
                updated_token_accounts.update(tx_info["token_accounts"])
                spl_token_txs.append(tx_info)

        except Exception as exc:
            logger.error(
                f"index_spl_token.py | Error parsing sol spl token transaction: {exc}"
            )
            raise exc

    update_user_ids: Set[int] = set()
    with db.scoped_session() as session:
        if updated_token_accounts:
            user_result = (
                session.query(User.user_id, UserBankAccount.bank_account)
                .join(UserBankAccount, UserBankAccount.ethereum_address == User.wallet)
                .filter(
                    UserBankAccount.bank_account.in_(list(updated_token_accounts)),
                    User.is_current == True,
                )
                .all()
            )
            user_set = {user[0] for user in user_result}
            user_bank_set = {user[1] for user in user_result}
            update_user_ids.update(user_set)

            audio_txs = process_spl_token_transactions(spl_token_txs, user_bank_set)
            session.bulk_save_objects(audio_txs)

        if updated_root_accounts:
            # Remove the user bank owner
            user_bank_owner, _ = get_base_address(SPL_TOKEN_PUBKEY, USER_BANK_PUBKEY)
            updated_root_accounts.discard(str(user_bank_owner))

            associated_wallet_result = (
                session.query(AssociatedWallet.user_id).filter(
                    AssociatedWallet.is_current == True,
                    AssociatedWallet.is_delete == False,
                    AssociatedWallet.chain == WalletChain.sol,
                    AssociatedWallet.wallet.in_(list(updated_root_accounts)),
                )
            ).all()
            associated_wallet_set = {user_id for [user_id] in associated_wallet_result}
            update_user_ids.update(associated_wallet_set)

        user_ids = list(update_user_ids)
        if user_ids:
            logger.info(
                f"index_spl_token.py | Enqueueing user ids {user_ids} to immediate balance refresh queue"
            )
            enqueue_immediate_balance_refresh(redis, user_ids)

        if tx_sig_batch_records:
            last_tx = tx_sig_batch_records[0]

            last_scanned_slot = last_tx["slot"]
            last_scanned_signature = last_tx["signature"]
            solana_logger.add_log(
                f"Updating last_scanned_slot to {last_scanned_slot} and signature to {last_scanned_signature}"
            )
            cache_latest_spl_audio_db_tx(
                redis,
                {
                    "signature": last_scanned_signature,
                    "slot": last_scanned_slot,
                    "timestamp": last_tx["blockTime"],
                },
            )

            record = session.query(SPLTokenTransaction).first()
            if record:
                record.last_scanned_slot = last_scanned_slot
                record.signature = last_scanned_signature
            else:
                record = SPLTokenTransaction(
                    last_scanned_slot=last_scanned_slot,
                    signature=last_scanned_signature,
                )
            session.add(record)

    batch_end_time = time.time()
    batch_duration = batch_end_time - batch_start_time
    solana_logger.add_log(
        f"processed batch {len(tx_sig_batch_records)} txs in {batch_duration}s"
    )

    return (update_user_ids, updated_root_accounts, updated_token_accounts)


def split_list(list, n):
    for i in range(0, len(list), n):
        yield list[i : i + n]


# Push to head of array containing seen transactions
# Used to avoid re-traversal from chain tail when slot diff > certain number
def cache_traversed_tx(redis: Redis, tx: ConfirmedSignatureForAddressResult):
    redis.lpush(REDIS_TX_CACHE_QUEUE_PREFIX, json.dumps(tx))


# Fetch the cached transaction from redis queue
# Eliminates transactions one by one if they are < latest db slot
def fetch_traversed_tx_from_cache(redis: Redis, latest_db_slot: Optional[int]):
    if latest_db_slot is None:
        return None
    cached_offset_tx_found = False
    while not cached_offset_tx_found:
        last_cached_tx_raw = redis.lrange(REDIS_TX_CACHE_QUEUE_PREFIX, 0, 1)
        if last_cached_tx_raw:
            last_cached_tx: ConfirmedSignatureForAddressResult = json.loads(
                last_cached_tx_raw[0]
            )
            redis.ltrim(REDIS_TX_CACHE_QUEUE_PREFIX, 1, -1)
            # If a single element is remaining, clear the list to avoid dupe processing
            if redis.llen(REDIS_TX_CACHE_QUEUE_PREFIX) == 1:
                redis.delete(REDIS_TX_CACHE_QUEUE_PREFIX)
            # Return if a valid signature is found
            if last_cached_tx["slot"] > latest_db_slot:
                cached_offset_tx_found = True
                last_tx_signature = last_cached_tx["signature"]
                return last_tx_signature
        else:
            break
    return None


def process_spl_token_tx(
    solana_client_manager: SolanaClientManager, db: SessionManager, redis: Redis
):
    solana_logger = SolanaIndexingLogger("index_spl_token")
    solana_logger.start_time("fetch_batches")
    try:
        base58.b58decode(SPL_TOKEN_PROGRAM)
    except ValueError:
        logger.error(
            f"index_spl_token.py"
            f"Invalid Token program ({SPL_TOKEN_PROGRAM}) configured, exiting."
        )
        return

    # Highest currently processed slot in the DB
    latest_processed_slot = get_latest_slot(db)
    solana_logger.add_log(f"latest used slot: {latest_processed_slot}")

    # Utilize the cached tx to offset
    cached_offset_tx = fetch_traversed_tx_from_cache(redis, latest_processed_slot)

    # The 'before' value from where we start querying transactions
    last_tx_signature = cached_offset_tx

    # Loop exit condition
    intersection_found = False

    # List of signatures that will be populated as we traverse recent operations
    transaction_signatures: List[ConfirmedSignatureForAddressResult] = []

    # Current batch of transactions
    transaction_signature_batch = []

    # Current batch
    page_count = 0
    is_initial_fetch = True

    # Traverse recent records until an intersection is found with latest slot
    while not intersection_found:
        fetch_size = (
            INITIAL_FETCH_SIZE if is_initial_fetch else FETCH_TX_SIGNATURES_BATCH_SIZE
        )
        solana_logger.add_log(
            f"Requesting {fetch_size} transactions before {last_tx_signature}"
        )
        transactions_history = solana_client_manager.get_signatures_for_address(
            SPL_TOKEN_PROGRAM,
            before=last_tx_signature,
            limit=fetch_size,
        )
        is_initial_fetch = False
        solana_logger.add_log(f"Retrieved transactions before {last_tx_signature}")
        transactions_array = transactions_history["result"]
        if not transactions_array:
            # This is considered an 'intersection' since there are no further transactions to process but
            # really represents the end of known history for this ProgramId
            intersection_found = True
            solana_logger.add_log(f"No transactions found before {last_tx_signature}")
        else:
            # handle initial case where no there is no stored latest processed slot and start from current
            if latest_processed_slot is None:
                logger.debug("index_spl_token.py | setting from none")
                transaction_signature_batch = transactions_array
                intersection_found = True
            else:
                for tx in transactions_array:
                    if tx["slot"] > latest_processed_slot:
                        transaction_signature_batch.append(tx)
                    elif tx["slot"] <= latest_processed_slot:
                        intersection_found = True
                        break
            # Restart processing at the end of this transaction signature batch
            last_tx = transactions_array[-1]
            last_tx_signature = last_tx["signature"]

            # Append to recently seen cache
            cache_traversed_tx(redis, last_tx)

            # Append batch of processed signatures
            if transaction_signature_batch:
                transaction_signatures.append(transaction_signature_batch)

            # Ensure processing does not grow unbounded
            if len(transaction_signatures) > TX_SIGNATURES_MAX_BATCHES:
                solana_logger.add_log(
                    f"slicing tx_sigs from {len(transaction_signatures)} entries"
                )
                transaction_signatures = transaction_signatures[
                    -TX_SIGNATURES_RESIZE_LENGTH:
                ]

            # Reset batch state
            transaction_signature_batch = []

        solana_logger.add_log(
            f"intersection_found={intersection_found},\
            last_tx_signature={last_tx_signature},\
            page_count={page_count}"
        )
        page_count = page_count + 1

    transaction_signatures.reverse()
    totals = {"user_ids": 0, "root_accts": 0, "token_accts": 0}
    solana_logger.end_time("fetch_batches")
    solana_logger.start_time("parse_batches")
    for tx_sig_batch in transaction_signatures:
        for tx_sig_batch_records in split_list(
            tx_sig_batch, TX_SIGNATURES_PROCESSING_SIZE
        ):
            user_ids, root_accounts, token_accounts = parse_sol_tx_batch(
                db, solana_client_manager, redis, tx_sig_batch_records, solana_logger
            )
            totals["user_ids"] += len(user_ids)
            totals["root_accts"] += len(root_accounts)
            totals["token_accts"] += len(token_accounts)

    solana_logger.end_time("parse_batches")
    solana_logger.add_context("total_user_ids_updated", totals["user_ids"])
    solana_logger.add_context("total_root_accts_updated", totals["root_accts"])
    solana_logger.add_context("total_token_accts_updated", totals["token_accts"])

    logger.info("index_spl_token.py", extra=solana_logger.get_context())


index_spl_token_lock = "spl_token_lock"


@celery.task(name="index_spl_token", bind=True)
@save_duration_metric(metric_group="celery_task")
def index_spl_token(self):
    # Cache custom task class properties
    # Details regarding custom task context can be found in wiki
    # Custom Task definition can be found in src/app.py
    redis = index_spl_token.redis
    solana_client_manager = index_spl_token.solana_client_manager
    db = index_spl_token.db
    # Define lock acquired boolean
    have_lock = False
    # Define redis lock object
    # Max duration of lock is 4hrs or 14400 seconds
    update_lock = redis.lock(index_spl_token_lock, blocking_timeout=25, timeout=14400)

    try:
        # Cache latest tx outside of lock
        fetch_and_cache_latest_program_tx_redis(
            solana_client_manager,
            redis,
            SPL_TOKEN_PROGRAM,
            latest_sol_spl_token_program_tx_key,
        )
        # Attempt to acquire lock - do not block if unable to acquire
        have_lock = update_lock.acquire(blocking=False)
        if have_lock:
            logger.info("index_spl_token.py | Acquired lock")
            process_spl_token_tx(solana_client_manager, db, redis)
    except Exception as e:
        logger.error("index_spl_token.py | Fatal error in main loop", exc_info=True)
        raise e
    finally:
        if have_lock:
            update_lock.release()
