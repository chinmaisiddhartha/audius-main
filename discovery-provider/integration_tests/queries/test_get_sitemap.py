import logging
from unittest import mock

from integration_tests.utils import populate_mock_db
from src.queries.get_sitemap import (
    build_default,
    get_playlist_page,
    get_playlist_root,
    get_track_page,
    get_track_root,
    get_user_page,
    get_user_root,
)
from src.utils.db_session import get_db

logger = logging.getLogger(__name__)


@mock.patch("src.queries.get_sitemap.get_client_base_url")
@mock.patch("src.queries.get_sitemap.set_base_url")
def test_get_sitemaps(mock_set_base_url, mock_get_client_base_url, app):
    """Tests that get sitemap works"""
    with app.app_context():
        db = get_db()

        mock_set_base_url.return_value = "https://discoveryprovider.audius.co"
        mock_get_client_base_url.return_value = "https://audius.co"

        test_entities = {
            "playlists": [
                {
                    "playlist_id": i,
                    "playlist_owner_id": i,
                    "playlist_name": f"p_name_{i}",
                    "is_album": i % 2 == 0,
                }
                for i in range(10)
            ],
            "tracks": [{"track_id": i, "owner_id": i} for i in range(10)],
            "track_routes": [
                {
                    "track_id": i,
                    "owner_id": i,
                    "slug": f"slug_{i}",
                    "title_slug": f"title_slug_{i}",
                }
                for i in range(10)
            ],
            "users": [{"user_id": i, "handle": f"user_{i}"} for i in range(20)],
        }

        populate_mock_db(db, test_entities)

        with db.scoped_session() as session:
            default_sitemap = build_default()
            assert (
                default_sitemap
                == b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>https://audius.co/legal/privacy-policy</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/legal/terms-of-use</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/download</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/feed</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/trending</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/explore</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/explore/playlists</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/explore/underground</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/explore/top-albums</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/explore/remixables</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/explore/feeling-lucky</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/explore/chill</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/explore/upbeat</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/explore/intense</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/explore/provoking</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/explore/intimate</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/signup</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/signin</loc>\n  </url>\n</urlset>\n'
            )

            # Validate that there are 7 track sitemaps  - 10 total track / 3 user per sitemap = 4
            track_root = get_track_root(session, 3)
            assert (
                track_root
                == b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <sitemap>\n    <loc>https://discoveryprovider.audius.co/sitemaps/track/1.xml</loc>\n  </sitemap>\n  <sitemap>\n    <loc>https://discoveryprovider.audius.co/sitemaps/track/2.xml</loc>\n  </sitemap>\n  <sitemap>\n    <loc>https://discoveryprovider.audius.co/sitemaps/track/3.xml</loc>\n  </sitemap>\n  <sitemap>\n    <loc>https://discoveryprovider.audius.co/sitemaps/track/4.xml</loc>\n  </sitemap>\n</urlset>\n'
            )

            # Validate that there are 6 playlist sitemaps -  10 total playlist / 2 user per sitemap = 5
            playlist_root = get_playlist_root(session, 2)
            assert (
                playlist_root
                == b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <sitemap>\n    <loc>https://discoveryprovider.audius.co/sitemaps/playlist/1.xml</loc>\n  </sitemap>\n  <sitemap>\n    <loc>https://discoveryprovider.audius.co/sitemaps/playlist/2.xml</loc>\n  </sitemap>\n  <sitemap>\n    <loc>https://discoveryprovider.audius.co/sitemaps/playlist/3.xml</loc>\n  </sitemap>\n  <sitemap>\n    <loc>https://discoveryprovider.audius.co/sitemaps/playlist/4.xml</loc>\n  </sitemap>\n  <sitemap>\n    <loc>https://discoveryprovider.audius.co/sitemaps/playlist/5.xml</loc>\n  </sitemap>\n</urlset>\n'
            )

            # Validate that there are 2 user sitemaps -  20 total user / 12 user per sitemap = 2
            user_root = get_user_root(session, 12)
            assert (
                user_root
                == b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <sitemap>\n    <loc>https://discoveryprovider.audius.co/sitemaps/user/1.xml</loc>\n  </sitemap>\n  <sitemap>\n    <loc>https://discoveryprovider.audius.co/sitemaps/user/2.xml</loc>\n  </sitemap>\n</urlset>\n'
            )

            # Validate that returns 6 track slugs
            track_page_1 = get_track_page(session, 1, 6)
            assert (
                track_page_1
                == b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>https://audius.co/user_0/slug_0</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_1/slug_1</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_2/slug_2</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_3/slug_3</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_4/slug_4</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_5/slug_5</loc>\n  </url>\n</urlset>\n'
            )

            # Validate that returns remained 4 track slugs and starts at 6
            track_page_2 = get_track_page(session, 2, 6)
            assert (
                track_page_2
                == b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>https://audius.co/user_6/slug_6</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_7/slug_7</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_8/slug_8</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_9/slug_9</loc>\n  </url>\n</urlset>\n'
            )

            # Validate that returns all playlist(total of 10)
            playlist_page_1 = get_playlist_page(session, 1, 100)
            assert (
                playlist_page_1
                == b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>https://audius.co/user_0/album/p_name_0-0</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_1/playlist/p_name_1-1</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_2/album/p_name_2-2</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_3/playlist/p_name_3-3</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_4/album/p_name_4-4</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_5/playlist/p_name_5-5</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_6/album/p_name_6-6</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_7/playlist/p_name_7-7</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_8/album/p_name_8-8</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_9/playlist/p_name_9-9</loc>\n  </url>\n</urlset>\n'
            )

            # Validate that starts at user 0 and 8 user slugs
            user_page_1 = get_user_page(session, 1, 8)
            assert (
                user_page_1
                == b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>https://audius.co/user_0</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_1</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_2</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_3</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_4</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_5</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_6</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_7</loc>\n  </url>\n</urlset>\n'
            )

            # Validate that starts at user 8*1=8 and 8 user slugs
            user_page_2 = get_user_page(session, 2, 8)
            assert (
                user_page_2
                == b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>https://audius.co/user_8</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_9</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_10</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_11</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_12</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_13</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_14</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_15</loc>\n  </url>\n</urlset>\n'
            )

            # Validate that starts at user 8*2=16 and only 4 user slugs (The remainder with 8 max)
            user_page_3 = get_user_page(session, 3, 8)
            assert (
                user_page_3
                == b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>https://audius.co/user_16</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_17</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_18</loc>\n  </url>\n  <url>\n    <loc>https://audius.co/user_19</loc>\n  </url>\n</urlset>\n'
            )
