"""Which blobs each user put in the blob store, by upload or from a server file.

The store is shared and keyed by content, so a hash proves nothing about who may read
what it names: a route that takes a hash from a client asks here first. Also what the
per-user quota counts."""

import contextlib
from pathlib import Path

from app.config import settings
from app.services import blob_store


def path_for(user_id: int) -> Path:
    return settings.data_path / "_uploads" / f"{user_id}.ledger"


def record(user_id: int, sha: str, size: int) -> None:
    # No room for this line must not fail an upload that succeeded.
    with contextlib.suppress(OSError):
        path = path_for(user_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a") as f:
            f.write(f"{sha} {size}\n")


def holds(user_id: int, sha: str) -> bool:
    """Whether `user_id` put this blob in the store, and it is still there. A hash
    someone else's upload produced answers as a missing one does."""
    if not blob_store.exists(sha):
        return False
    try:
        lines = path_for(user_id).read_text().splitlines()
    except OSError:
        return False
    return any(line.split(" ", 1)[0] == sha for line in lines)
