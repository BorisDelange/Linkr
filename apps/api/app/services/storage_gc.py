"""Reclaim disk left behind by interrupted work and pre-cleanup deletions.

Three kinds of garbage accumulate in the data dir, none of which any live row
points at:

* ``_tmp/<uploadId>/`` — a chunked upload session is only removed when the
  client calls ``/uploads/{id}/complete``. A closed tab, a dropped connection or
  a rejected file leaves its chunks behind forever, so sessions are swept by age.
* ``_files/<sha>`` — a blob whose last referencing row is gone. Deletion paths
  deref their own blobs, so this only catches what escaped them (a crash between
  the commit and the unlink, or rows removed before that wiring existed).
* ``projects/<uid>/`` — a project working directory with no row in ``projects``.

Sweeping runs at startup and then periodically (see ``run_periodic``). Age is
what makes every sweep safe, because on-disk state is always created before the
row that claims it: writing a chunk bumps its session's mtime, and a blob or
project dir exists for a moment before its row is committed. Only entries that
have stayed unclaimed for a long time are collected, so work in flight — however
slow the client — is never pulled out from under it.
"""

import asyncio
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path

import structlog
from sqlalchemy import select

from app.config import settings
from app.core.database import async_session
from app.models.project import Project
from app.services import blob_cleanup, blob_store

logger = structlog.get_logger()

# An upload session older than this is presumed abandoned. Generous on purpose:
# a slow client uploading a multi-GB file over a poor link must not have its
# session collected mid-transfer.
UPLOAD_MAX_AGE_SECONDS = 24 * 3600

# Grace period before an unreferenced blob may be collected. A blob lands on disk
# before the row pointing at it is committed, so a brand-new one can look orphaned
# while its import is still in flight. An hour is far beyond that window and costs
# only a delayed collection.
BLOB_MIN_AGE_SECONDS = 3600

_PERIOD_SECONDS = 6 * 3600


@dataclass
class GcReport:
    """What a sweep removed (or would remove, in dry-run)."""

    upload_sessions: int = 0
    upload_bytes: int = 0
    orphan_blobs: int = 0
    orphan_blob_bytes: int = 0
    orphan_project_dirs: int = 0
    orphan_project_bytes: int = 0
    missing_blobs: list[str] = field(default_factory=list)

    @property
    def total_bytes(self) -> int:
        return self.upload_bytes + self.orphan_blob_bytes + self.orphan_project_bytes


def _dir_size(path: Path) -> int:
    total = 0
    for p in path.rglob("*"):
        try:
            if p.is_file():
                total += p.stat().st_size
        except OSError:
            continue
    return total


def _entry_size(path: Path) -> int:
    try:
        return path.stat().st_size if path.is_file() else _dir_size(path)
    except OSError:
        return 0


def _sweep_uploads(report: GcReport, dry_run: bool, now: float) -> None:
    root = settings.data_path / "_tmp"
    if not root.is_dir():
        return
    for session in root.iterdir():
        if not session.is_dir():
            continue
        try:
            age = now - session.stat().st_mtime
        except OSError:
            continue
        if age < UPLOAD_MAX_AGE_SECONDS:
            continue
        report.upload_sessions += 1
        report.upload_bytes += _dir_size(session)
        if not dry_run:
            shutil.rmtree(session, ignore_errors=True)


async def _sweep_blobs(report: GcReport, dry_run: bool, now: float) -> None:
    """Delete blobs no row references, and report referenced shas whose file is
    missing (the opposite failure — a dangling pointer, which GC cannot fix)."""
    root = settings.data_path / "_files"

    async with async_session() as db:
        referenced = await blob_cleanup.all_referenced_shas(db)

    # An absent store is not an early return: every referenced sha is then a
    # dangling pointer, which is exactly what the missing_blobs report is for.
    on_disk = (
        {p.name for p in root.iterdir() if p.is_file() and blob_store.is_sha(p.name)}
        if root.is_dir()
        else set()
    )

    report.missing_blobs = sorted(referenced - on_disk)

    for sha in on_disk - referenced:
        path = root / sha
        # A blob is written to disk *before* the row that references it exists
        # (upload completes, then the dataset/file row is created). A young
        # unreferenced blob may therefore be one of those in-flight writes, not
        # garbage — skip it and let a later sweep collect it if it stays orphaned.
        try:
            if now - path.stat().st_mtime < BLOB_MIN_AGE_SECONDS:
                continue
        except OSError:
            continue
        report.orphan_blobs += 1
        report.orphan_blob_bytes += _entry_size(path)
        if not dry_run:
            await blob_store.delete(sha)


async def _sweep_project_dirs(report: GcReport, dry_run: bool, now: float) -> None:
    root = settings.data_path / "projects"
    if not root.is_dir():
        return

    async with async_session() as db:
        result = await db.execute(select(Project.uid))
        live = {uid for (uid,) in result.all()}

    for d in root.iterdir():
        if not d.is_dir() or d.name in live:
            continue
        # Same in-flight guard as blobs: the working dir can be created before the
        # project row is committed, so only collect one that has stayed unclaimed.
        try:
            if now - d.stat().st_mtime < BLOB_MIN_AGE_SECONDS:
                continue
        except OSError:
            continue
        report.orphan_project_dirs += 1
        report.orphan_project_bytes += _dir_size(d)
        if not dry_run:
            shutil.rmtree(d, ignore_errors=True)


async def sweep(dry_run: bool = False) -> GcReport:
    """Run every sweep. With `dry_run`, only measure — nothing is deleted."""
    report = GcReport()
    now = time.time()
    await asyncio.to_thread(_sweep_uploads, report, dry_run, now)
    await _sweep_blobs(report, dry_run, now)
    await _sweep_project_dirs(report, dry_run, now)
    return report


async def sweep_and_log(dry_run: bool = False) -> GcReport:
    report = await sweep(dry_run=dry_run)
    if report.total_bytes or report.missing_blobs:
        logger.info(
            "storage_gc",
            dry_run=dry_run,
            upload_sessions=report.upload_sessions,
            orphan_blobs=report.orphan_blobs,
            orphan_project_dirs=report.orphan_project_dirs,
            reclaimed_mb=round(report.total_bytes / (1024 * 1024), 1),
            missing_blobs=len(report.missing_blobs),
        )
    return report


async def run_periodic() -> None:
    """Sweep at startup, then every `_PERIOD_SECONDS`, until cancelled.

    A failed sweep must never kill the loop: the data dir is shared with live
    work (an ETL writing, a user uploading), so a transient OSError on one entry
    is expected and the next pass simply retries.
    """
    while True:
        try:
            await sweep_and_log()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("storage_gc_failed")
        await asyncio.sleep(_PERIOD_SECONDS)
