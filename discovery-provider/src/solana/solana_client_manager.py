import logging
import random
import signal
import time
from contextlib import contextmanager
from typing import Optional, Union

from solana.keypair import Keypair
from solana.publickey import PublicKey
from solana.rpc.api import Client, Commitment
from solana.rpc.types import TokenAccountOpts
from src.exceptions import UnsupportedVersionError
from src.solana.solana_helpers import SPL_TOKEN_ID_PK
from src.solana.solana_transaction_types import (
    ConfirmedSignatureForAddressResponse,
    ConfirmedTransaction,
)

logger = logging.getLogger(__name__)

# maximum number of times to retry get_confirmed_transaction call
DEFAULT_MAX_RETRIES = 5
# number of seconds to wait between calls to get_confirmed_transaction
DELAY_SECONDS = 0.2
UNSUPPORTED_VERSION_ERROR_CODE = -32015


class SolanaClientManager:
    def __init__(self, solana_endpoints) -> None:
        self.endpoints = solana_endpoints.split(",")
        self.clients = [Client(endpoint) for endpoint in self.endpoints]

    def get_client(self, randomize=False) -> Client:
        if not self.clients:
            raise Exception(
                "solana_client_manager.py | get_client | There are no solana clients"
            )
        if not randomize:
            return self.clients[0]
        index = random.randrange(0, len(self.clients))
        return self.clients[index]

    def get_sol_tx_info(
        self, tx_sig: str, retries=DEFAULT_MAX_RETRIES, encoding="json"
    ):
        """Fetches a solana transaction by signature with retries and a delay."""

        def handle_get_sol_tx_info(client: Client, index: int):
            endpoint = self.endpoints[index]
            num_retries = retries
            while num_retries > 0:
                try:
                    tx_info: ConfirmedTransaction = client.get_transaction(
                        tx_sig, encoding
                    )
                    _check_error(tx_info, tx_sig)
                    if tx_info["result"] is not None:
                        return tx_info
                # We currently only support "legacy" solana transactions. If we encounter
                # a newer version, raise this specific error so that it can be handled upstream.
                except UnsupportedVersionError as e:
                    raise e
                except Exception as e:
                    logger.error(
                        f"solana_client_manager.py | get_sol_tx_info | \
                            Error fetching tx {tx_sig} from endpoint {endpoint}, {e}",
                        exc_info=True,
                    )
                num_retries -= 1
                time.sleep(DELAY_SECONDS)
                logger.error(
                    f"solana_client_manager.py | get_sol_tx_info | Retrying tx fetch: {tx_sig} with endpoint {endpoint}"
                )
            raise Exception(
                f"solana_client_manager.py | get_sol_tx_info | Failed to fetch {tx_sig} with endpoint {endpoint}"
            )

        return _try_all(
            self.clients,
            handle_get_sol_tx_info,
            f"solana_client_manager.py | get_sol_tx_info | All requests failed to fetch {tx_sig}",
        )

    def get_signatures_for_address(
        self,
        account: Union[str, Keypair, PublicKey],
        before: Optional[str] = None,
        until: Optional[str] = None,
        limit: Optional[int] = None,
        retries: int = DEFAULT_MAX_RETRIES,
    ):
        """Fetches confirmed signatures for transactions given an address."""

        def handle_get_signatures_for_address(client: Client, index: int):
            endpoint = self.endpoints[index]
            num_retries = retries
            while num_retries > 0:
                try:
                    transactions: ConfirmedSignatureForAddressResponse = (
                        client.get_signatures_for_address(
                            account, before, until, limit, Commitment("finalized")
                        )
                    )
                    return transactions
                except Exception as e:
                    logger.error(
                        f"solana_client_manager.py | handle_get_signatures_for_address | \
                            Error fetching account {account} from endpoint {endpoint}, {e}",
                        exc_info=True,
                    )
                num_retries -= 1
                time.sleep(DELAY_SECONDS)
                logger.error(
                    f"solana_client_manager.py | handle_get_signatures_for_address | Retrying account fetch: {account} with endpoint {endpoint}"
                )
            raise Exception(
                f"solana_client_manager.py | handle_get_signatures_for_address | Failed to fetch account {account} with endpoint {endpoint}"
            )

        return _try_all_with_timeout(
            self.clients,
            handle_get_signatures_for_address,
            "solana_client_manager.py | get_signatures_for_address | All requests failed",
        )

    def get_slot(self, retries=DEFAULT_MAX_RETRIES, encoding="json") -> Optional[int]:
        def _get_slot(client: Client, index):
            endpoint = self.endpoints[index]
            num_retries = retries
            while num_retries > 0:
                try:
                    response = client.get_slot(Commitment("finalized"))
                    return response["result"]
                except Exception as e:
                    logger.error(
                        f"solana_client_manager.py | get_slot, {e}",
                        exc_info=True,
                    )
                num_retries -= 1
                time.sleep(DELAY_SECONDS)
                logger.error(
                    f"solana_client_manager.py | get_slot | Retrying with endpoint {endpoint}"
                )
            raise Exception(
                f"solana_client_manager.py | get_slot | Failed with endpoint {endpoint}"
            )

        return _try_all(
            self.clients,
            _get_slot,
            "solana_client_manager.py | get_slot | All requests failed to fetch",
        )

    def get_token_accounts_by_owner(
        self, owner: PublicKey, retries=DEFAULT_MAX_RETRIES
    ):
        def _get_token_accounts_by_owner(client: Client, index):
            endpoint = self.endpoints[index]
            num_retries = retries
            while num_retries > 0:
                try:
                    response = client.get_token_accounts_by_owner(
                        owner,
                        TokenAccountOpts(
                            program_id=SPL_TOKEN_ID_PK, encoding="jsonParsed"
                        ),
                    )
                    return response["result"]
                except Exception as e:
                    logger.error(
                        f"solana_client_manager.py | get_token_accounts_by_owner, {e}",
                        exc_info=True,
                    )
                num_retries -= 1
                time.sleep(DELAY_SECONDS)
                logger.error(
                    f"solana_client_manager.py | get_token_accounts_by_owner | Retrying with endpoint {endpoint}"
                )
            raise Exception(
                f"solana_client_manager.py | get_token_accounts_by_owner | Failed with endpoint {endpoint}"
            )

        return _try_all(
            self.clients,
            _get_token_accounts_by_owner,
            "solana_client_manager.py | get_token_accounts_by_owner | All requests failed to fetch",
        )

    def get_account_info(self, account: PublicKey, retries=DEFAULT_MAX_RETRIES):
        def _get_account_info(client: Client, index):
            endpoint = self.endpoints[index]
            num_retries = retries
            while num_retries > 0:
                try:
                    response = client.get_account_info(account)
                    return response["result"]
                except Exception as e:
                    logger.error(
                        f"solana_client_manager.py | get_account_info, {e}",
                        exc_info=True,
                    )
                num_retries -= 1
                time.sleep(DELAY_SECONDS)
                logger.error(
                    f"solana_client_manager.py | get_account_info | Retrying with endpoint {endpoint}"
                )
            raise Exception(
                f"solana_client_manager.py | get_account_info | Failed with endpoint {endpoint}"
            )

        return _try_all(
            self.clients,
            _get_account_info,
            "solana_client_manager.py | get_account_info | All requests failed to fetch",
        )


@contextmanager
def timeout(time):
    # Register a function to raise a TimeoutError on the signal.
    signal.signal(signal.SIGALRM, raise_timeout)
    # Schedule the signal to be sent after ``time``.
    signal.alarm(time)

    try:
        yield
    except TimeoutError:  # pylint: disable=W0706
        raise
    finally:
        # Unregister the signal so it won't be triggered
        # if the timeout is not reached.
        signal.signal(signal.SIGALRM, signal.SIG_IGN)


def raise_timeout(signum, frame):
    raise TimeoutError


def _check_error(tx, tx_sig):
    if "error" in tx:
        logger.error(
            f"solana_client_manager.py | _check_unsupported_version | Transaction {tx_sig} version is unsupported"
        )
        raise UnsupportedVersionError()


def _try_all(iterable, func, message, randomize=False):
    """Executes a function with retries across the iterable.
    If all executions fail, raise an exception."""
    items = list(enumerate(iterable))
    items = items if not randomize else random.sample(items, k=len(items))
    for index, value in items:
        try:
            return func(value, index)
        except UnsupportedVersionError as e:
            raise e
        except Exception:
            logger.error(
                f"solana_client_manager.py | _try_all | Failed attempt at index {index} for function {func}"
            )
            if index < len(items) - 1:
                logger.info("solana_client_manager.py | _try_all | Retrying")
            continue
    raise Exception(message)


def _try_all_with_timeout(iterable, func, message, randomize=False):
    """Do not use this function with ThreadPoolExecutor,
    doesn't play well with futures

    Executes a function with retries across the iterable.
    If all executions fail, raise an exception."""
    items = list(enumerate(iterable))
    items = items if not randomize else random.sample(items, k=len(items))
    for index, value in items:
        try:
            with timeout(30):
                return func(value, index)
        except Exception:
            logger.error(
                f"solana_client_manager.py | _try_all | Failed attempt at index {index} for function {func}"
            )
            if index < len(items) - 1:
                logger.info("solana_client_manager.py | _try_all | Retrying")
            continue
    raise Exception(message)
