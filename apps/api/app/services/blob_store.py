"""Content-addressed blob storage on the local filesystem.

Heavy/binary content (dataset rows, raw uploads, attachments, parquet) lives on
disk under ``data_dir/_files/<sha256>`` rather than in the database. Files are
keyed by the SHA-256 of their content, which gives free deduplication: importing
the same OHDSI vocabulary into two data sources stores the bytes once. The
relational DB holds the sha pointer (and reference counting is by "is any row
still pointing at this sha?", checked by callers before delete).
"""

import asyncio
import hashlib
import shutil
from pathlib import Path

from app.config import settings

_CHUNK = 1024 * 1024  # 1 MiB streaming buffer


def _files_dir() -> Path:
    d = settings.data_path / "_files"
    d.mkdir(parents=True, exist_ok=True)
    return d


def path_for(sha: str) -> Path:
    """Absolute path of the blob with this content hash (may not exist)."""
    return _files_dir() / sha


def exists(sha: str) -> bool:
    return path_for(sha).is_file()


def _store_file_sync(src: Path) -> tuple[str, int]:
    """Hash `src` and move it into the store under its sha. Returns (sha, size)."""
    h = hashlib.sha256()
    size = 0
    with src.open("rb") as f:
        while chunk := f.read(_CHUNK):
            h.update(chunk)
            size += len(chunk)
    sha = h.hexdigest()
    dest = path_for(sha)
    if dest.exists():
        src.unlink(missing_ok=True)  # already stored — dedup
    else:
        shutil.move(str(src), str(dest))
    return sha, size


async def store_file(src: Path) -> tuple[str, int]:
    """Move a file already on disk (e.g. an assembled upload) into the store."""
    return await asyncio.to_thread(_store_file_sync, src)


def _store_bytes_sync(data: bytes) -> tuple[str, int]:
    sha = hashlib.sha256(data).hexdigest()
    dest = path_for(sha)
    if not dest.exists():
        tmp = dest.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(dest)
    return sha, len(data)


async def store_bytes(data: bytes) -> tuple[str, int]:
    """Store an in-memory byte string. Returns (sha, size)."""
    return await asyncio.to_thread(_store_bytes_sync, data)


async def read_bytes(sha: str) -> bytes:
    return await asyncio.to_thread(path_for(sha).read_bytes)


async def delete(sha: str) -> None:
    """Remove a blob. Callers must ensure no row still references this sha."""
    await asyncio.to_thread(lambda: path_for(sha).unlink(missing_ok=True))
