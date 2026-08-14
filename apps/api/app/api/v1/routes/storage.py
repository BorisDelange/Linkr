"""Admin storage maintenance: inspect and reclaim unreferenced disk.

The sweep already runs on its own (startup + periodically). These endpoints
exist so an administrator can see what is reclaimable without waiting for the
next pass, and trigger one on demand — e.g. after deleting a large project, or
when diagnosing a data dir that grew unexpectedly.
"""

from fastapi import APIRouter, Depends

from app.core.deps import get_current_admin
from app.models.user import User
from app.schemas.base import CamelModel
from app.services import storage_gc

router = APIRouter(prefix="/storage", tags=["storage"])


class StorageGcResponse(CamelModel):
    dry_run: bool
    upload_sessions: int
    upload_bytes: int
    orphan_blobs: int
    orphan_blob_bytes: int
    orphan_project_dirs: int
    orphan_project_bytes: int
    total_bytes: int
    # Shas a row still points at but whose file is gone. GC cannot fix these —
    # surfaced so an admin sees the broken references rather than silently
    # serving a 404 later. Capped to a sample (an unmounted volume makes every
    # referenced sha missing); `missing_blobs_total` carries the real count.
    missing_blobs: list[str]
    missing_blobs_total: int


def _to_response(report: storage_gc.GcReport, dry_run: bool) -> StorageGcResponse:
    return StorageGcResponse(
        dry_run=dry_run,
        upload_sessions=report.upload_sessions,
        upload_bytes=report.upload_bytes,
        orphan_blobs=report.orphan_blobs,
        orphan_blob_bytes=report.orphan_blob_bytes,
        orphan_project_dirs=report.orphan_project_dirs,
        orphan_project_bytes=report.orphan_project_bytes,
        total_bytes=report.total_bytes,
        missing_blobs=report.missing_blobs,
        missing_blobs_total=report.missing_blobs_total,
    )


@router.get("/gc", response_model=StorageGcResponse)
async def preview_gc(_admin: User = Depends(get_current_admin)):
    """Report what a sweep would reclaim, without deleting anything."""
    return _to_response(await storage_gc.sweep(dry_run=True), dry_run=True)


@router.post("/gc", response_model=StorageGcResponse)
async def run_gc(_admin: User = Depends(get_current_admin)):
    """Run a sweep now and report what it reclaimed."""
    return _to_response(await storage_gc.sweep_and_log(), dry_run=False)
