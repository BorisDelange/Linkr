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
what makes every sweep safe: on-disk state is created before the row that claims
it, so only entries that have stayed unclaimed for a long time are collected and
work in flight — however slow the client — is never pulled out from under it.

That argument holds only because each sweep reads an age that actually tracks
"when was this last touched", which is NOT what the obvious `stat()` gives:

* a chunk write bumps its session dir's mtime directly, so ``_tmp`` is fine as-is;
* ``shutil.move`` PRESERVES mtime, so a blob would inherit the age of the upload
  that produced it — ``blob_store._mark_stored`` stamps it on the way in instead;
* a directory's mtime ignores writes inside its subdirectories, so a project dir
  is aged by its newest descendant (``_newest_mtime``), not by its own entry.

Get any of those wrong and the grace period silently becomes zero.
"""

import asyncio
import contextlib
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

# How many missing shas a report carries. Enough to debug from, bounded so a
# missing volume cannot turn the report into a multi-megabyte response.
MAX_MISSING_BLOBS_REPORTED = 100

# One sweep at a time. Two overlapping runs each rglob the whole data dir and
# each report the same reclaimed bytes, so an admin hammering the button (or one
# arriving while the periodic pass runs) doubles the I/O and misreports the total.
_sweep_lock = asyncio.Lock()


@dataclass
class GcReport:
    """What a sweep removed (or would remove, in dry-run)."""

    upload_sessions: int = 0
    upload_bytes: int = 0
    orphan_blobs: int = 0
    orphan_blob_bytes: int = 0
    orphan_project_dirs: int = 0
    orphan_project_bytes: int = 0
    # Capped: an unmounted volume makes EVERY referenced sha "missing", and the
    # uncapped list put hundreds of thousands of 64-char strings in one JSON
    # response (and held them in memory on every periodic sweep). The count is
    # what tells you something is wrong; the sample is what you debug with.
    missing_blobs: list[str] = field(default_factory=list)
    missing_blobs_total: int = 0

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

    missing = sorted(referenced - on_disk)
    report.missing_blobs_total = len(missing)
    report.missing_blobs = missing[:MAX_MISSING_BLOBS_REPORTED]

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

    # `store_bytes` writes `<sha>.tmp` then renames it. A crash in between leaks
    # the temp file, and `is_sha` (rightly) excludes it from `on_disk`, so no
    # sweep would ever have collected it. Same grace period: a .tmp younger than
    # that may be a write in flight.
    if not root.is_dir():
        return
    for path in root.glob("*.tmp"):
        try:
            if not path.is_file() or now - path.stat().st_mtime < BLOB_MIN_AGE_SECONDS:
                continue
        except OSError:
            continue
        report.orphan_blobs += 1
        report.orphan_blob_bytes += _entry_size(path)
        if not dry_run:
            with contextlib.suppress(OSError):
                path.unlink()


def _newest_mtime(d: Path) -> float:
    """The mtime of the most recently touched thing anywhere under `d`.

    A directory's own mtime only moves when an entry is added or removed
    DIRECTLY inside it, not when files in its subdirectories change. Every real
    project writes into `scripts/`, `datasets/`, `environments/`, so the top
    dir's mtime is frozen at creation and reading it would call a project in
    daily use "untouched since January". Walking the tree is what makes the age
    guard mean anything here.
    """
    newest = d.stat().st_mtime
    for p in d.rglob("*"):
        try:
            newest = max(newest, p.stat().st_mtime)
        except OSError:
            continue
    return newest


async def _sweep_project_dirs(report: GcReport, dry_run: bool, now: float) -> None:
    root = settings.data_path / "projects"
    if not root.is_dir():
        return

    async with async_session() as db:
        result = await db.execute(select(Project.uid))
        live = {uid for (uid,) in result.all()}

    candidates = [d for d in root.iterdir() if d.is_dir() and d.name not in live]

    # Refuse to act on a wholesale mismatch. Every project dir looking orphaned
    # is far more likely a database that is not the one this data dir belongs to
    # (a restored snapshot, a mispointed LINKR_DATABASE_URL, a half-applied
    # migration) than a genuine mass orphan — and the cost of being wrong here is
    # every project's working tree, which is the source of truth for IDE files
    # and datasets. Bail loudly and let a human look.
    if not live and candidates:
        logger.error(
            "storage_gc_skipped_project_sweep",
            reason="no live projects but project dirs exist — refusing to delete",
            candidates=len(candidates),
        )
        return

    for d in candidates:
        # Same in-flight guard as blobs: the working dir can be created before the
        # project row is committed, so only collect one that has stayed unclaimed.
        try:
            if now - _newest_mtime(d) < BLOB_MIN_AGE_SECONDS:
                continue
        except OSError:
            continue
        report.orphan_project_dirs += 1
        report.orphan_project_bytes += _dir_size(d)
        if not dry_run:
            shutil.rmtree(d, ignore_errors=True)


async def sweep(dry_run: bool = False) -> GcReport:
    """Run every sweep. With `dry_run`, only measure — nothing is deleted.

    Serialized: a concurrent sweep would walk the same tree and count the same
    bytes again, so overlapping runs cost double the I/O and report totals that
    were already reclaimed by the other.
    """
    async with _sweep_lock:
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
