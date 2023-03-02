from datetime import datetime

from src.models.indexing.block import Block
from src.models.indexing.indexing_checkpoints import IndexingCheckpoint
from src.models.indexing.ursm_content_node import UrsmContentNode
from src.models.notifications.notification import NotificationSeen, PlaylistSeen
from src.models.playlists.playlist import Playlist
from src.models.playlists.playlist_route import PlaylistRoute
from src.models.rewards.challenge import Challenge
from src.models.rewards.challenge_disbursement import ChallengeDisbursement
from src.models.rewards.reward_manager import RewardManagerTransaction
from src.models.rewards.user_challenge import UserChallenge
from src.models.social.aggregate_monthly_plays import AggregateMonthlyPlay
from src.models.social.aggregate_plays import AggregatePlay
from src.models.social.follow import Follow
from src.models.social.hourly_play_counts import HourlyPlayCount
from src.models.social.play import Play
from src.models.social.reaction import Reaction
from src.models.social.repost import Repost
from src.models.social.save import Save
from src.models.social.subscription import Subscription
from src.models.tracks.aggregate_track import AggregateTrack
from src.models.tracks.remix import Remix
from src.models.tracks.stem import Stem
from src.models.tracks.track import Track
from src.models.tracks.track_route import TrackRoute
from src.models.users.aggregate_user import AggregateUser
from src.models.users.associated_wallet import AssociatedWallet, WalletChain
from src.models.users.supporter_rank_up import SupporterRankUp
from src.models.users.user import User
from src.models.users.user_balance_change import UserBalanceChange
from src.models.users.user_bank import UserBankAccount, UserBankTx
from src.models.users.user_listening_history import UserListeningHistory
from src.models.users.user_tip import UserTip
from src.tasks.aggregates import get_latest_blocknumber
from src.utils import helpers
from src.utils.db_session import get_db


def query_creator_by_name(app, creator_name=None):
    """Return list of creators filtered by name (if present)"""
    query_results = None
    with app.app_context():
        db = get_db()

        with db.scoped_session() as session:
            if creator_name is not None:
                query_results = (
                    session.query(User)
                    .filter(User.name == creator_name)
                    .order_by(User.user_id)
                    .all()
                )
            else:
                query_results = session.query(User).order_by(User.user_id).all()

            assert query_results is not None
            return_list = helpers.query_result_to_list(query_results)
            return return_list


def toBytes(val, length=32):
    val = val[:length]
    return bytes(val, "utf-8")


def populate_mock_db_blocks(db, min, max):
    """
    Helper function to populate the mock DB with blocks

    Args:
        db - sqlalchemy db session
        min - min block number
        max - max block number
    """
    with db.scoped_session() as session:
        for i in range(min, max):
            block = Block(
                blockhash=hex(i),
                number=i,
                parenthash="0x01",
                is_current=(i == 0),
            )
            session.add(block)
            session.flush()


def populate_mock_db(db, entities, block_offset=None):
    """
    Helper function to populate the mock DB with tracks, users, plays, and follows

    Args:
        db - sqlalchemy db session
        entities - dict of keys tracks, users, plays of arrays of metadata
    """
    with db.scoped_session() as session:
        # check if blocknumber already exists for longer running tests
        if block_offset is None:
            block_offset = get_latest_blocknumber(session)
            if block_offset:
                block_offset += 1
            else:
                block_offset = 0

        tracks = entities.get("tracks", [])
        playlists = entities.get("playlists", [])
        users = entities.get("users", [])
        follows = entities.get("follows", [])
        subscriptions = entities.get("subscriptions", [])
        reposts = entities.get("reposts", [])
        saves = entities.get("saves", [])
        track_routes = entities.get("track_routes", [])
        playlist_routes = entities.get("playlist_routes", [])
        remixes = entities.get("remixes", [])
        stems = entities.get("stems", [])
        challenges = entities.get("challenges", [])
        user_challenges = entities.get("user_challenges", [])
        plays = entities.get("plays", [])
        aggregate_plays = entities.get("aggregate_plays", [])
        aggregate_track = entities.get("aggregate_track", [])
        aggregate_monthly_plays = entities.get("aggregate_monthly_plays", [])
        aggregate_user = entities.get("aggregate_user", [])
        indexing_checkpoints = entities.get("indexing_checkpoints", [])
        user_listening_history = entities.get("user_listening_history", [])
        hourly_play_counts = entities.get("hourly_play_counts", [])
        user_bank_accounts = entities.get("user_bank_accounts", [])
        associated_wallets = entities.get("associated_wallets", [])
        ursm_content_nodes = entities.get("ursm_content_nodes", [])
        reactions = entities.get("reactions", [])
        user_bank_txs = entities.get("user_bank_txs", [])
        user_tips = entities.get("user_tips", [])
        supporter_rank_ups = entities.get("supporter_rank_ups", [])
        reward_manager_txs = entities.get("reward_manager_txs", [])
        challenge_disbursements = entities.get("challenge_disbursements", [])
        notification_seens = entities.get("notification_seens", [])
        playlist_seens = entities.get("playlist_seens", [])
        user_balance_changes = entities.get("user_balance_changes", [])

        num_blocks = max(
            len(tracks),
            len(users),
            len(follows),
            len(saves),
            len(reposts),
            len(subscriptions),
            len(playlist_seens),
        )
        for i in range(block_offset, block_offset + num_blocks):
            max_block = session.query(Block).filter(Block.number == i).first()
            session.query(Block).filter(Block.is_current == True).update(
                {"is_current": False}
            )
            if not max_block:
                block = Block(
                    blockhash=hex(i),
                    number=i,
                    parenthash="0x01",
                    is_current=(i == block_offset + num_blocks - 1),
                )
                session.add(block)
                session.flush()

        for i, track_meta in enumerate(tracks):
            track_id = track_meta.get("track_id", i)

            # mark previous tracks as is_current = False
            session.query(Track).filter(Track.is_current == True).filter(
                Track.track_id == track_id
            ).update({"is_current": False})

            track = Track(
                blockhash=hex(i + block_offset),
                blocknumber=i + block_offset,
                txhash=track_meta.get("txhash", str(i + block_offset)),
                track_id=track_id,
                title=track_meta.get("title", f"track_{i}"),
                is_current=track_meta.get("is_current", True),
                is_delete=track_meta.get("is_delete", False),
                owner_id=track_meta.get("owner_id", 1),
                route_id=track_meta.get("route_id", ""),
                track_segments=track_meta.get("track_segments", []),
                tags=track_meta.get("tags", None),
                genre=track_meta.get("genre", ""),
                remix_of=track_meta.get("remix_of", None),
                updated_at=track_meta.get("updated_at", datetime.now()),
                created_at=track_meta.get("created_at", datetime.now()),
                release_date=track_meta.get("release_date", None),
                is_unlisted=track_meta.get("is_unlisted", False),
                is_premium=track_meta.get("is_premium", False),
                premium_conditions=track_meta.get("premium_conditions", None),
                is_playlist_upload=track_meta.get("is_playlist_upload", False),
            )
            session.add(track)
        for i, playlist_meta in enumerate(playlists):
            playlist = Playlist(
                blockhash=hex(i + block_offset),
                blocknumber=i + block_offset,
                txhash=playlist_meta.get("txhash", str(i + block_offset)),
                playlist_id=playlist_meta.get("playlist_id", i),
                is_current=playlist_meta.get("is_current", True),
                is_delete=playlist_meta.get("is_delete", False),
                playlist_owner_id=playlist_meta.get("playlist_owner_id", 1),
                is_album=playlist_meta.get("is_album", False),
                is_private=playlist_meta.get("is_private", False),
                playlist_name=playlist_meta.get("playlist_name", f"playlist_{i}"),
                playlist_contents=playlist_meta.get(
                    "playlist_contents", {"track_ids": []}
                ),
                playlist_image_multihash=playlist_meta.get(
                    "playlist_image_multihash", ""
                ),
                playlist_image_sizes_multihash=playlist_meta.get(
                    "playlist_image_sizes_multihash", ""
                ),
                description=playlist_meta.get("description", f"description_{i}"),
                upc=playlist_meta.get("upc", f"upc_{i}"),
                updated_at=playlist_meta.get("updated_at", datetime.now()),
                created_at=playlist_meta.get("created_at", datetime.now()),
            )
            session.add(playlist)

        for i, user_meta in enumerate(users):
            user = User(
                blockhash=hex(i + block_offset),
                blocknumber=i + block_offset,
                txhash=user_meta.get("txhash", str(i + block_offset)),
                user_id=user_meta.get("user_id", i),
                is_current=user_meta.get("is_current", True),
                handle=user_meta.get("handle", str(i)),
                handle_lc=user_meta.get("handle", str(i)).lower(),
                artist_pick_track_id=user_meta.get("artist_pick_track_id"),
                wallet=user_meta.get("wallet", str(i)),
                bio=user_meta.get("bio", str(i)),
                profile_picture=user_meta.get("profile_picture"),
                profile_picture_sizes=user_meta.get("profile_picture_sizes"),
                cover_photo=user_meta.get("cover_photo"),
                cover_photo_sizes=user_meta.get("cover_photo_sizes"),
                updated_at=user_meta.get("updated_at", datetime.now()),
                created_at=user_meta.get("created_at", datetime.now()),
                primary_id=user_meta.get("primary_id"),
                secondary_ids=user_meta.get("secondary_ids"),
                replica_set_update_signer=user_meta.get("replica_set_update_signer"),
                creator_node_endpoint=user_meta.get(
                    "creator_node_endpoint", "https://cn.io"
                ),
            )
            user_bank = UserBankAccount(
                signature=f"0x{i}",
                ethereum_address=user_meta.get("wallet", str(i)),
                bank_account=f"0x{i}",
                created_at=datetime.now(),
            )
            session.add(user)
            session.add(user_bank)

        for i, follow_meta in enumerate(follows):
            follow = Follow(
                blockhash=hex(i + block_offset),
                blocknumber=follow_meta.get("blocknumber", i + block_offset),
                follower_user_id=follow_meta.get("follower_user_id", i + 1),
                followee_user_id=follow_meta.get("followee_user_id", i),
                is_current=follow_meta.get("is_current", True),
                is_delete=follow_meta.get("is_delete", False),
                created_at=follow_meta.get("created_at", datetime.now()),
            )
            session.add(follow)
        for i, subscription_meta in enumerate(subscriptions):
            subscription = Subscription(
                blockhash=hex(i + block_offset),
                blocknumber=subscription_meta.get("blocknumber", i + block_offset),
                subscriber_id=subscription_meta.get("subscriber_id", i + 1),
                user_id=subscription_meta.get("user_id", i),
                is_current=subscription_meta.get("is_current", True),
                is_delete=subscription_meta.get("is_delete", False),
                created_at=subscription_meta.get("created_at", datetime.now()),
            )
            session.add(subscription)
        for i, repost_meta in enumerate(reposts):
            repost = Repost(
                blockhash=hex(i + block_offset),
                blocknumber=repost_meta.get("blocknumber", i + block_offset),
                txhash=repost_meta.get("txhash", str(i + block_offset)),
                user_id=repost_meta.get("user_id", i + 1),
                repost_item_id=repost_meta.get("repost_item_id", i),
                repost_type=repost_meta.get("repost_type", "track"),
                is_current=repost_meta.get("is_current", True),
                is_delete=repost_meta.get("is_delete", False),
                created_at=repost_meta.get("created_at", datetime.now()),
            )
            session.add(repost)
        for i, save_meta in enumerate(saves):
            save = Save(
                blockhash=hex(i + block_offset),
                blocknumber=save_meta.get("blocknumber", i + block_offset),
                txhash=save_meta.get("txhash", str(i + block_offset)),
                user_id=save_meta.get("user_id", i + 1),
                save_item_id=save_meta.get("save_item_id", i),
                save_type=save_meta.get("save_type", "track"),
                is_current=save_meta.get("is_current", True),
                is_delete=save_meta.get("is_delete", False),
                created_at=save_meta.get("created_at", datetime.now()),
            )
            session.add(save)

        for i, play_meta in enumerate(plays):
            play = Play(
                id=play_meta.get("id", i + 1),
                user_id=play_meta.get("user_id", i + 1),
                source=play_meta.get("source", None),
                play_item_id=play_meta.get("item_id", i + 1),
                slot=play_meta.get("slot", i + 1),
                signature=play_meta.get("signature", None),
                created_at=play_meta.get("created_at", datetime.now()),
                updated_at=play_meta.get("updated_at", datetime.now()),
            )
            session.add(play)

        for i, aggregate_play_meta in enumerate(aggregate_plays):
            aggregate_play = AggregatePlay(
                play_item_id=aggregate_play_meta.get("play_item_id", i),
                count=aggregate_play_meta.get("count", 0),
            )
            session.add(aggregate_play)

        for i, aggregate_track_meta in enumerate(aggregate_track):
            aggregate_track = AggregateTrack(
                track_id=aggregate_track_meta.get("track_id", i),
                repost_count=aggregate_track_meta.get("repost_count", 0),
                save_count=aggregate_track_meta.get("save_count", 0),
            )
            session.add(aggregate_track)

        for i, aggregate_monthly_play_meta in enumerate(aggregate_monthly_plays):
            aggregate_monthly_play = AggregateMonthlyPlay(
                play_item_id=aggregate_monthly_play_meta.get("play_item_id", i),
                timestamp=aggregate_monthly_play_meta.get("timestamp", i),
                count=aggregate_monthly_play_meta.get("count", 0),
            )
            session.add(aggregate_monthly_play)

        for i, aggregate_user_meta in enumerate(aggregate_user):
            user = AggregateUser(
                user_id=aggregate_user_meta.get("user_id", i),
                track_count=aggregate_user_meta.get("track_count", 0),
                playlist_count=aggregate_user_meta.get("playlist_count", 0),
                album_count=aggregate_user_meta.get("album_count", 0),
                follower_count=aggregate_user_meta.get("follower_count", 0),
                following_count=aggregate_user_meta.get("following_count", 0),
                repost_count=aggregate_user_meta.get("repost_count", 0),
                track_save_count=aggregate_user_meta.get("track_save_count", 0),
            )
            session.add(user)

        for i, user_listening_history_meta in enumerate(user_listening_history):
            user_listening_history = UserListeningHistory(
                user_id=user_listening_history_meta.get("user_id", i + 1),
                listening_history=user_listening_history_meta.get(
                    "listening_history", None
                ),
            )
            session.add(user_listening_history)

        for i, hourly_play_count_meta in enumerate(hourly_play_counts):
            hourly_play_count = HourlyPlayCount(
                hourly_timestamp=hourly_play_count_meta.get(
                    "hourly_timestamp", datetime.now()
                ),
                play_count=hourly_play_count_meta.get("play_count", 0),
            )
            session.add(hourly_play_count)

        if indexing_checkpoints:
            session.execute(
                "TRUNCATE TABLE indexing_checkpoints"
            )  # clear primary keys before adding
            for i, indexing_checkpoint_meta in enumerate(indexing_checkpoints):
                indexing_checkpoint = IndexingCheckpoint(
                    tablename=indexing_checkpoint_meta.get("tablename", None),
                    last_checkpoint=indexing_checkpoint_meta.get("last_checkpoint", 0),
                )
                session.add(indexing_checkpoint)

        for i, route_meta in enumerate(track_routes):
            route = TrackRoute(
                slug=route_meta.get("slug", ""),
                title_slug=route_meta.get("title_slug", ""),
                blockhash=hex(i + block_offset),
                blocknumber=route_meta.get("blocknumber", i + block_offset),
                owner_id=route_meta.get("owner_id", i + 1),
                track_id=route_meta.get("track_id", i + 1),
                is_current=route_meta.get("is_current", True),
                txhash=route_meta.get("txhash", str(i + 1)),
                collision_id=route_meta.get("collision_id", 0),
            )
            session.add(route)

        for i, route_meta in enumerate(playlist_routes):
            route = PlaylistRoute(
                slug=route_meta.get("slug", ""),
                title_slug=route_meta.get("title_slug", ""),
                blockhash=hex(i + block_offset),
                blocknumber=route_meta.get("blocknumber", i + block_offset),
                owner_id=route_meta.get("owner_id", i + 1),
                playlist_id=route_meta.get("playlist_id", i + 1),
                is_current=route_meta.get("is_current", True),
                txhash=route_meta.get("txhash", str(i + 1)),
                collision_id=route_meta.get("collision_id", 0),
            )
            session.add(route)

        for i, remix_meta in enumerate(remixes):
            remix = Remix(
                parent_track_id=remix_meta.get("parent_track_id", i),
                child_track_id=remix_meta.get("child_track_id", i + 1),
            )
            session.add(remix)
        for i, stems_meta in enumerate(stems):
            stem = Stem(
                parent_track_id=stems_meta.get("parent_track_id", i),
                child_track_id=stems_meta.get("child_track_id", i + 1),
            )
            session.add(stem)

        for i, challenge_meta in enumerate(challenges):
            challenge = Challenge(
                id=challenge_meta.get("id", ""),
                type=challenge_meta.get("type", ""),
                amount=challenge_meta.get("amount", ""),
                active=challenge_meta.get("active", True),
                step_count=challenge_meta.get("step_count", None),
                starting_block=challenge_meta.get("starting_block", None),
            )
            session.add(challenge)
        for i, user_challenge_meta in enumerate(user_challenges):
            user_challenge = UserChallenge(
                challenge_id=user_challenge_meta.get("challenge_id", ""),
                user_id=user_challenge_meta.get("user_id", 1),
                specifier=user_challenge_meta.get("specifier", ""),
                is_complete=user_challenge_meta.get("is_complete", False),
                completed_blocknumber=user_challenge_meta.get(
                    "completed_blocknumber", 1 + block_offset
                ),
                current_step_count=user_challenge_meta.get("current_step_count", None),
            )
            session.add(user_challenge)
        for i, user_bank_account in enumerate(user_bank_accounts):
            bank = UserBankAccount(
                signature=user_bank_account.get("signature", ""),
                ethereum_address=user_bank_account.get("ethereum_address", ""),
                bank_account=user_bank_account.get("bank_account", ""),
                created_at=user_bank_account.get("created_at", datetime.now()),
            )
            session.add(bank)
        for i, associated_wallet in enumerate(associated_wallets):
            wallet = AssociatedWallet(
                blockhash=associated_wallet.get("blockhash", hex(i + block_offset)),
                blocknumber=associated_wallet.get("blocknumber", i + block_offset),
                is_current=associated_wallet.get("is_current", True),
                is_delete=associated_wallet.get("is_delete", False),
                user_id=associated_wallet.get("user_id", 1),
                wallet=associated_wallet.get("wallet", str(i)),
                chain=associated_wallet.get("chain", WalletChain.sol),
            )
            session.add(wallet)
        for i, ursm_content_node in enumerate(ursm_content_nodes):
            node = UrsmContentNode(
                blockhash=ursm_content_node.get("blockhash", hex(i + block_offset)),
                blocknumber=ursm_content_node.get("blocknumber", i + block_offset),
                slot=ursm_content_node.get("slot", i + 1),
                txhash=ursm_content_node.get("txhash", str(i + block_offset)),
                is_current=ursm_content_node.get("is_current", True),
                cnode_sp_id=ursm_content_node.get("cnode_sp_id", i + 1),
                delegate_owner_wallet=ursm_content_node.get(
                    "delegate_owner_wallet",
                    "delegate_owner_wallet_" + str(i + block_offset),
                ),
                owner_wallet=ursm_content_node.get(
                    "owner_wallet", "owner_wallet" + str(i + block_offset)
                ),
                proposer_sp_ids=ursm_content_node.get("proposer_sp_ids", [0, 0, 0]),
                proposer_1_delegate_owner_wallet=ursm_content_node.get(
                    "proposer_1_delegate_owner_wallet",
                    "proposer_1_delegate_owner_wallet_" + str(i + block_offset),
                ),
                proposer_2_delegate_owner_wallet=ursm_content_node.get(
                    "proposer_2_delegate_owner_wallet",
                    "proposer_2_delegate_owner_wallet_" + str(i + block_offset),
                ),
                proposer_3_delegate_owner_wallet=ursm_content_node.get(
                    "proposer_3_delegate_owner_wallet",
                    "proposer_3_delegate_owner_wallet_" + str(i + block_offset),
                ),
                endpoint=ursm_content_node.get("endpoint", f"www.content_node{i}.com"),
                created_at=ursm_content_node.get("created_at", datetime.now()),
            )
            session.add(node)
        for i, reaction in enumerate(reactions):
            reaction = Reaction(
                id=reaction.get("id", i),
                slot=reaction.get("slot", i),
                reaction_value=reaction.get("reaction_value", 1),
                sender_wallet=reaction.get("sender_wallet", "0x"),
                reaction_type=reaction.get("reaction_type", "type"),
                reacted_to=reaction.get("reacted_to", "reaction_to"),
                timestamp=reaction.get("timestamp", datetime.now()),
                tx_signature=reaction.get("tx_signature", str(i)),
            )
            session.add(reaction)
        for i, user_bank_tx in enumerate(user_bank_txs):
            ubtx = UserBankTx(
                slot=user_bank_tx.get("slot", i),
                signature=user_bank_tx.get("signature", str(i)),
                created_at=user_bank_tx.get("created_at", datetime.now()),
            )
            session.add(ubtx)
        for i, supporter_rank_up in enumerate(supporter_rank_ups):
            sru = SupporterRankUp(
                slot=supporter_rank_up.get("slot", i),
                sender_user_id=supporter_rank_up.get("sender_user_id", i),
                receiver_user_id=supporter_rank_up.get("receiver_user_id", i),
                rank=supporter_rank_up.get("rank", 1),
            )
            session.add(sru)
        for i, user_tip in enumerate(user_tips):
            ut = UserTip(
                slot=user_tip.get("slot", i),
                signature=user_tip.get("signature", str(i)),
                sender_user_id=user_tip.get("sender_user_id", i),
                receiver_user_id=user_tip.get("receiver_user_id", i),
                amount=user_tip.get("amount", i),
                created_at=user_tip.get("created_at", datetime.now()),
                updated_at=user_tip.get("updated_at", datetime.now()),
            )
            session.add(ut)
        for i, reward_manager_tx in enumerate(reward_manager_txs):
            rmtx = RewardManagerTransaction(
                slot=reward_manager_tx.get("slot", i),
                signature=reward_manager_tx.get("signature", str(i)),
                created_at=reward_manager_tx.get("created_at", datetime.now()),
            )
            session.add(rmtx)
        for i, challenge_disbursement in enumerate(challenge_disbursements):
            cb = ChallengeDisbursement(
                challenge_id=challenge_disbursement.get("challenge_id", str(i)),
                user_id=challenge_disbursement.get("user_id", i),
                specifier=challenge_disbursement.get("specifier", str(i)),
                signature=challenge_disbursement.get("signature", str(i)),
                slot=challenge_disbursement.get("slot", i),
                amount=challenge_disbursement.get("amount", i),
            )
            session.add(cb)
        for i, playlist_seen in enumerate(playlist_seens):
            ps = PlaylistSeen(
                user_id=playlist_seen.get("user_id", i),
                playlist_id=playlist_seen.get("playlist_id", i),
                is_current=playlist_seen.get("is_current", True),
                seen_at=playlist_seen.get("seen_at", datetime.now()),
                blockhash=playlist_seen.get("blockhash", str(i)),
                blocknumber=playlist_seen.get("blocknumber", str(i)),
                txhash=playlist_seen.get("txhash", str(i)),
            )
            session.add(ps)
        for i, notification_seen in enumerate(notification_seens):
            ns = NotificationSeen(
                user_id=notification_seen.get("user_id", i),
                blocknumber=notification_seen.get("blocknumber", i),
                blockhash=notification_seen.get("signature", str(i)),
                seen_at=notification_seen.get("seen_at", datetime.now()),
            )
            session.add(ns)
        for i, balance_change in enumerate(user_balance_changes):
            ns = UserBalanceChange(
                user_id=balance_change.get("user_id", i),
                blocknumber=balance_change.get("blocknumber", i),
                current_balance=balance_change.get("current_balance", 0),
                previous_balance=balance_change.get("previous_balance", 0),
                created_at=balance_change.get("created_at", datetime.now()),
                updated_at=balance_change.get("updated_at", datetime.now()),
            )
            session.add(ns)

        session.commit()
