from typing import Any, List, Optional, TypedDict

# Required format for track metadata retrieved from the content system


class TrackDownload(TypedDict):
    cid: Optional[str]
    is_downloadable: bool
    requires_follow: bool


class TrackParent(TypedDict):
    parent_track_id: int


class TrackRemix(TypedDict):
    tracks: List[TrackParent]


class TrackStem(TypedDict):
    parent_track_id: int
    category: str


class TrackFieldVisibility(TypedDict):
    genre: bool
    mood: bool
    play_count: bool
    share: bool
    tags: bool
    remixes: Optional[bool]


class TrackSegment(TypedDict):
    multihash: str
    duration: float


class TrackMetadata(TypedDict):
    track_cid: Optional[str]
    owner_id: Optional[int]
    title: Optional[str]
    route_id: Optional[str]
    length: int
    cover_art: Optional[str]
    cover_art_sizes: Optional[str]
    tags: Optional[str]
    genre: Optional[str]
    mood: Optional[str]
    credits_splits: Optional[str]
    create_date: None
    release_date: None
    file_type: None
    description: Optional[str]
    license: Optional[str]
    isrc: Optional[str]
    iswc: Optional[str]
    track_segments: List[TrackSegment]
    download: Any
    remix_of: Optional[TrackRemix]
    is_unlisted: bool
    field_visibility: Optional[TrackFieldVisibility]
    stem_of: Optional[TrackStem]
    is_premium: Optional[bool]
    premium_conditions: Optional[Any]
    is_playlist_upload: Optional[bool]


track_metadata_format: TrackMetadata = {
    "track_cid": None,
    "owner_id": None,
    "title": None,
    "route_id": None,
    "length": 0,
    "cover_art": None,
    "cover_art_sizes": None,
    "tags": None,
    "genre": None,
    "mood": None,
    "credits_splits": None,
    "create_date": None,
    "release_date": None,
    "file_type": None,
    "description": None,
    "license": None,
    "isrc": None,
    "iswc": None,
    "track_segments": [],
    "download": {},
    "remix_of": None,
    "is_unlisted": False,
    "field_visibility": None,
    "stem_of": None,
    "is_premium": False,
    "premium_conditions": None,
    "is_playlist_upload": False,
}

# Required format for user metadata retrieved from the content system
user_metadata_format = {
    "profile_picture": None,
    "profile_picture_sizes": None,
    "cover_photo": None,
    "cover_photo_sizes": None,
    "bio": None,
    "name": None,
    "location": None,
    "handle": None,
    "associated_wallets": None,
    "associated_sol_wallets": None,
    "collectibles": None,
    "playlist_library": None,
    "events": None,
    "is_deactivated": None,
    "artist_pick_track_id": None,
}


class PlaylistMetadata(TypedDict):
    playlist_id: Optional[int]
    playlist_contents: Optional[Any]
    playlist_name: Optional[str]
    playlist_image_sizes_multihash: Optional[str]
    description: Optional[str]
    is_album: Optional[bool]
    is_private: Optional[bool]


playlist_metadata_format: PlaylistMetadata = {
    "playlist_id": None,
    "playlist_contents": None,
    "playlist_name": None,
    "playlist_image_sizes_multihash": None,
    "description": None,
    "is_album": None,
    "is_private": None,
}
