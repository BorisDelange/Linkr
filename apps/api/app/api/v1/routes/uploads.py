"""Resumable chunked file upload.

Large files (OHDSI vocabularies, big CSV/Parquet) are uploaded in chunks so a
dropped connection can resume by re-sending only the missing indices. Each
session is a temp dir under ``data_dir/_tmp/<uploadId>/`` holding one file per
chunk index plus a ``_meta.json``. On complete, chunks are concatenated in order
and moved into the content-addressed blob store; the caller then references the
returned sha (e.g. a dataset import).
"""

import json
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.config import settings
from app.core.deps import get_current_user
from app.models.user import User
from app.schemas.base import CamelModel
from app.services import blob_store

router = APIRouter(prefix="/uploads", tags=["uploads"])

_CHUNK = 1024 * 1024


def _session_dir(upload_id: str) -> Path:
    # uuid4 hex only — reject anything that could escape the tmp root.
    if not upload_id.isalnum():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid upload id")
    return settings.data_path / "_tmp" / upload_id


class InitRequest(CamelModel):
    file_name: str
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
async def init_upload(body: InitRequest, _user: User = Depends(get_current_user)):
    upload_id = uuid.uuid4().hex
    d = _session_dir(upload_id)
    d.mkdir(parents=True, exist_ok=True)
    (d / "_meta.json").write_text(
        json.dumps(
            {"fileName": body.file_name, "totalChunks": body.total_chunks,
             "fileSize": body.file_size}
        )
    )
    return InitResponse(upload_id=upload_id, received=[])


@router.get("/{upload_id}", response_model=InitResponse)
async def upload_status(upload_id: str, _user: User = Depends(get_current_user)):
    """Report which chunk indices are already stored, so the client resumes."""
    d = _session_dir(upload_id)
    if not (d / "_meta.json").exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown upload")
    received = sorted(int(p.name) for p in d.iterdir() if p.name.isdigit())
    return InitResponse(upload_id=upload_id, received=received)


@router.put("/{upload_id}/chunk", status_code=status.HTTP_204_NO_CONTENT)
async def put_chunk(
    upload_id: str,
    index: int,
    request: Request,
    _user: User = Depends(get_current_user),
):
    d = _session_dir(upload_id)
    if not (d / "_meta.json").exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown upload")
    if index < 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid chunk index")
    # Stream the raw body to disk without buffering the whole chunk in memory.
    tmp = d / f"{index}.part"
    with tmp.open("wb") as f:
        async for piece in request.stream():
            f.write(piece)
    tmp.replace(d / str(index))


@router.post("/{upload_id}/complete", response_model=CompleteResponse)
async def complete_upload(upload_id: str, _user: User = Depends(get_current_user)):
    d = _session_dir(upload_id)
    meta_path = d / "_meta.json"
    if not meta_path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown upload")
    meta = json.loads(meta_path.read_text())
    total = int(meta["totalChunks"])

    missing = [i for i in range(total) if not (d / str(i)).exists()]
    if missing:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"error": "missing_chunks", "missing": missing},
        )

    assembled = d / "_assembled"
    with assembled.open("wb") as out:
        for i in range(total):
            with (d / str(i)).open("rb") as part:
                while buf := part.read(_CHUNK):
                    out.write(buf)

    sha, size = await blob_store.store_file(assembled)

    # Clean up the whole session dir (assembled file was moved out by store_file).
    for p in d.iterdir():
        p.unlink(missing_ok=True)
    d.rmdir()

    return CompleteResponse(sha=sha, size=size, file_name=meta["fileName"])
