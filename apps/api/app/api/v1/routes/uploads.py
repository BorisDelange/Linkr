"""Resumable chunked file upload.

Large files (OHDSI vocabularies, big CSV/Parquet) are uploaded in chunks so a
dropped connection can resume by re-sending only the missing indices. Each
session is a temp dir under ``data_dir/_tmp/<uploadId>/`` holding one file per
chunk index plus a ``_meta.json``. On complete, chunks are concatenated in order
and moved into the content-addressed blob store; the caller then references the
returned sha (e.g. a dataset import).
"""

import asyncio
import itertools
import contextlib
import json
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import Field

from app.config import settings
from app.core.deps import get_current_user
from app.models.user import User
from app.schemas.base import CamelModel
from app.services import blob_store, upload_ledger

router = APIRouter(prefix="/uploads", tags=["uploads"])

_CHUNK = 1024 * 1024
_MIN_CHUNK_BYTES = 64 * 1024
_MIN_CHUNK_ALLOWANCE = 1024
MISSING_REPORTED = 1000
_MB = 1024 * 1024

# What the chunks being received announced and have not written yet, as
# (user id, bytes): a disk check alone would let chunks arriving together all pass
# on the same free space. In memory: the API runs a single worker.
_incoming: dict[object, tuple[int, int]] = {}


def _max_upload_bytes() -> int:
    return settings.max_upload_mb * 1024 * 1024


def _max_chunks() -> int:
    return max(_MIN_CHUNK_ALLOWANCE, _max_upload_bytes() // _MIN_CHUNK_BYTES)


def _free_bytes() -> int:
    return shutil.disk_usage(settings.data_path).free


def _incoming_bytes(user_id: int | None = None) -> int:
    return sum(n for owner, n in _incoming.values() if user_id is None or owner == user_id)


def limits_off() -> bool:
    """Neither a free-space reserve nor a quota: any account can fill the data volume,
    which in the shipped compose holds the app database. Off by default so that an
    upgrade refuses no upload; the API says so at boot."""
    return settings.upload_free_space_reserve_mb <= 0 and settings.upload_quota_mb <= 0


def _require_room(incoming: int) -> None:
    """Writing `incoming` more bytes leaves the free space reserve untouched."""
    reserve_mb = settings.upload_free_space_reserve_mb
    if reserve_mb > 0 and _free_bytes() - _incoming_bytes() - incoming < reserve_mb * _MB:
        raise HTTPException(
            status.HTTP_507_INSUFFICIENT_STORAGE,
            detail={
                "code": "upload_no_space",
                "message": f"Not enough free space on the server: uploads must leave {reserve_mb} MB free.",
                "reserveMb": reserve_mb,
            },
        )


def _blobs_held(user_id: int) -> int:
    """Bytes of what this user uploaded that the blob store still holds, whether
    a row references it yet or not. A blob another user uploaded too counts for both."""
    path = upload_ledger.path_for(user_id)
    if not path.exists():
        return 0
    recorded = dict(line.split() for line in path.read_text().splitlines())
    live = {sha: size for sha, size in recorded.items() if blob_store.exists(sha)}
    if len(live) != len(recorded):
        with contextlib.suppress(OSError):
            path.write_text("".join(f"{sha} {size}\n" for sha, size in live.items()))
    return sum(int(size) for size in live.values())


def _sessions_held(user_id: int) -> int:
    total = 0
    root = settings.data_path / "_tmp"
    if not root.is_dir():
        return 0
    for d in root.iterdir():
        # A session finishing or swept meanwhile simply no longer counts.
        with contextlib.suppress(OSError, ValueError):
            if json.loads((d / "_meta.json").read_text()).get("userId") == user_id:
                total += _session_bytes(d)
    return total


def _held_bytes(user_id: int) -> int:
    return _sessions_held(user_id) + _blobs_held(user_id)


def _require_quota(user_id: int, held: int, incoming: int) -> None:
    quota_mb = settings.upload_quota_mb
    if quota_mb > 0 and held + _incoming_bytes(user_id) + incoming > quota_mb * _MB:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            detail={
                "code": "upload_quota_exceeded",
                "message": f"This upload would exceed your storage quota of {quota_mb} MB.",
                "quotaMb": quota_mb,
            },
        )


async def _held_for_quota(user_id: int) -> int:
    return await asyncio.to_thread(_held_bytes, user_id) if settings.upload_quota_mb > 0 else 0


def _announced_bytes(request: Request) -> int:
    with contextlib.suppress(TypeError, ValueError):
        return max(0, int(request.headers.get("content-length")))
    return 0


def _session_dir(upload_id: str) -> Path:
    # uuid4 hex only — reject anything that could escape the tmp root.
    if not upload_id.isalnum():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid upload id")
    return settings.data_path / "_tmp" / upload_id


def _own_session(upload_id: str, user: User) -> tuple[Path, dict]:
    """The session dir and its meta, for the user who opened it only. Anyone else
    gets the same 404 as for an unknown id: another user's upload is neither
    readable, appendable nor completable, nor even confirmed to exist."""
    d = _session_dir(upload_id)
    meta_path = d / "_meta.json"
    if not meta_path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown upload")
    meta = json.loads(meta_path.read_text())
    if meta.get("userId") != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown upload")
    return d, meta


def _session_bytes(d: Path) -> int:
    """Total bytes already written for this upload session (chunk files only)."""
    return sum(p.stat().st_size for p in d.iterdir() if p.name.isdigit())


def _missing_chunks(d: Path, total: int) -> tuple[list[int], int]:
    """The first missing indices and how many there are, from a listing of what is
    stored: the cost follows the upload, never the count its opener declared."""
    stored = {int(p.name) for p in d.iterdir() if p.name.isdigit()}
    count = total - sum(1 for i in stored if i < total)
    first = itertools.islice((i for i in range(total) if i not in stored), MISSING_REPORTED)
    return list(first), count


class InitRequest(CamelModel):
    file_name: str = Field(max_length=1024)
    total_chunks: int
    file_size: int | None = None


class InitResponse(CamelModel):
    upload_id: str
    received: list[int]  # chunk indices already stored (for resume)


class CompleteResponse(CamelModel):
    sha: str
    size: int
    file_name: str


@router.post("", response_model=InitResponse)
async def init_upload(body: InitRequest, user: User = Depends(get_current_user)):
    # Reject early when the declared size already exceeds the cap (saves the
    # round-trips); put_chunk still enforces the real size for clients that lie
    # about or omit file_size.
    if body.file_size is not None and body.file_size > _max_upload_bytes():
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            f"File exceeds the {settings.max_upload_mb} MB upload limit.",
        )
    if body.total_chunks < 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid chunk count")
    if body.total_chunks > _max_chunks():
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, f"An upload holds at most {_max_chunks()} chunks.")
    declared = body.file_size or 0
    _require_room(declared)
    _require_quota(user.id, await _held_for_quota(user.id), declared)
    upload_id = uuid.uuid4().hex
    d = _session_dir(upload_id)
    d.mkdir(parents=True, exist_ok=True)
    (d / "_meta.json").write_text(
        json.dumps(
            {"fileName": body.file_name, "totalChunks": body.total_chunks,
             "fileSize": body.file_size, "userId": user.id}
        )
    )
    return InitResponse(upload_id=upload_id, received=[])


@router.get("/{upload_id}", response_model=InitResponse)
async def upload_status(upload_id: str, user: User = Depends(get_current_user)):
    """Report which chunk indices are already stored, so the client resumes."""
    d, _ = _own_session(upload_id, user)
    received = sorted(int(p.name) for p in d.iterdir() if p.name.isdigit())
    return InitResponse(upload_id=upload_id, received=received)


@router.put("/{upload_id}/chunk", status_code=status.HTTP_204_NO_CONTENT)
async def put_chunk(
    upload_id: str,
    index: int,
    request: Request,
    user: User = Depends(get_current_user),
):
    d, meta = _own_session(upload_id, user)
    if not 0 <= index < int(meta["totalChunks"]):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid chunk index")
    # Stream the raw body to disk without buffering the whole chunk in memory,
    # aborting if the session's total size crosses the cap (real enforcement, even
    # when the client understated or omitted file_size at init).
    limit = _max_upload_bytes()
    # Bytes already stored, excluding this index if it's being re-sent (resume).
    existing = d / str(index)
    written = _session_bytes(d) - (existing.stat().st_size if existing.exists() else 0)
    announced = _announced_bytes(request)
    _require_room(announced)
    held = await _held_for_quota(user.id) - (existing.stat().st_size if existing.exists() else 0)
    _require_quota(user.id, held, announced)
    tmp = d / f"{index}.part"
    receiving = object()
    _incoming[receiving] = (user.id, announced)
    received = 0
    try:
        with tmp.open("wb") as f:
            async for piece in request.stream():
                received += len(piece)
                written += len(piece)
                if written > limit:
                    raise HTTPException(
                        status.HTTP_413_CONTENT_TOO_LARGE,
                        f"Upload exceeds the {settings.max_upload_mb} MB limit.",
                    )
                # Past what it announced (no Content-Length): checked as it comes.
                if received > announced:
                    _require_room(len(piece))
                    _require_quota(user.id, held, received)
                f.write(piece)
                _incoming[receiving] = (user.id, max(0, announced - received))
        tmp.replace(existing)
    except BaseException:
        # A disconnected client too: the session cap counts finished chunks only.
        tmp.unlink(missing_ok=True)
        raise
    finally:
        _incoming.pop(receiving, None)


def _assemble(d: Path, total: int) -> Path:
    assembled = d / "_assembled"
    with assembled.open("wb") as out:
        for i in range(total):
            with (d / str(i)).open("rb") as part:
                while buf := part.read(_CHUNK):
                    out.write(buf)
    return assembled


def _drop_session(d: Path) -> None:
    """The whole session dir; the assembled file was moved out by store_file."""
    for p in d.iterdir():
        p.unlink(missing_ok=True)
    d.rmdir()


@router.post("/{upload_id}/complete", response_model=CompleteResponse)
async def complete_upload(upload_id: str, user: User = Depends(get_current_user)):
    d, meta = _own_session(upload_id, user)
    total = int(meta["totalChunks"])

    missing, missing_count = await asyncio.to_thread(_missing_chunks, d, total)
    if missing_count:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"error": "missing_chunks", "missing": missing, "missingCount": missing_count},
        )

    # Assembled beside its chunks, so the file briefly takes its size a second time.
    _require_room(await asyncio.to_thread(_session_bytes, d))

    # Copying gigabytes takes a while: off the event loop, or every other
    # request waits for it.
    assembled = await asyncio.to_thread(_assemble, d, total)
    sha, size = await blob_store.store_file(assembled)
    await asyncio.to_thread(_drop_session, d)
    await asyncio.to_thread(upload_ledger.record, user.id, sha, size)

    return CompleteResponse(sha=sha, size=size, file_name=meta["fileName"])
