"""The storage sweep reclaims abandoned uploads, unreferenced blobs and orphan
project dirs — and must never touch anything still in use."""

import os
import time

import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings
from app.models.dataset import DatasetFile
from app.models.project import Project
from app.models.workspace import Workspace
from app.services import storage_gc


@pytest_asyncio.fixture(autouse=True)
async def _gc_uses_test_db(engine, monkeypatch):
    """Point storage_gc at the test database for every test in this module.

    The sweep opens its own session via `async_session` instead of the get_db
    dependency, so without this it would query the real ~/.linkr database and see
    none of the rows a test just created — then treat every blob on disk as
    unreferenced. Autouse (and depending on `engine`) because every test here
    calls sweep(), including the ones that create no rows: they still need the
    query to hit an empty test DB rather than the developer's real one.
    """
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(storage_gc, "async_session", maker)


def _make_session(name: str, age_seconds: float, size: int = 32):
    d = settings.data_path / "_tmp" / name
    d.mkdir(parents=True)
    (d / "_meta.json").write_text("{}")
    (d / "0").write_bytes(b"x" * size)
    old = time.time() - age_seconds
    os.utime(d, (old, old))
    return d


def _age(path, seconds: float):
    old = time.time() - seconds
    os.utime(path, (old, old))
    return path


def _make_blob(sha: str, size: int = 16, age_seconds: float | None = None):
    d = settings.data_path / "_files"
    d.mkdir(parents=True, exist_ok=True)
    blob = d / sha
    blob.write_bytes(b"y" * size)
    # Old enough to be past the in-flight grace period unless a test wants it new.
    return _age(blob, storage_gc.BLOB_MIN_AGE_SECONDS + 60 if age_seconds is None else age_seconds)


_SHA_A = "a" * 64
_SHA_B = "b" * 64


async def test_sweeps_abandoned_upload_but_keeps_one_in_flight():
    stale = _make_session("stale", storage_gc.UPLOAD_MAX_AGE_SECONDS + 60)
    fresh = _make_session("fresh", 60)

    report = await storage_gc.sweep()

    assert not stale.exists()
    assert fresh.exists()
    assert report.upload_sessions == 1


async def test_dry_run_measures_without_deleting():
    stale = _make_session("stale", storage_gc.UPLOAD_MAX_AGE_SECONDS + 60, size=100)

    report = await storage_gc.sweep(dry_run=True)

    assert stale.exists()
    assert report.upload_sessions == 1
    assert report.upload_bytes >= 100


async def test_deletes_unreferenced_blob_keeps_referenced_one(db):
    ws = Workspace(id="ws1", name={"en": "W"})
    db.add(ws)
    await db.commit()
    project = Project(uid="p1", workspace_id="ws1", name={"en": "P"})
    db.add(project)
    await db.commit()
    db.add(
        DatasetFile(id="f1", project_uid="p1", name="d", type="file", data_sha=_SHA_A)
    )
    await db.commit()

    referenced = _make_blob(_SHA_A)
    orphan = _make_blob(_SHA_B)

    report = await storage_gc.sweep()

    assert referenced.exists()
    assert not orphan.exists()
    assert report.orphan_blobs == 1


async def test_reports_referenced_blob_whose_file_is_missing(db):
    ws = Workspace(id="ws1", name={"en": "W"})
    db.add(ws)
    await db.commit()
    project = Project(uid="p1", workspace_id="ws1", name={"en": "P"})
    db.add(project)
    await db.commit()
    db.add(
        DatasetFile(id="f1", project_uid="p1", name="d", type="file", data_sha=_SHA_A)
    )
    await db.commit()
    # No blob written for _SHA_A — a dangling pointer the sweep can only report.

    report = await storage_gc.sweep()

    assert report.missing_blobs == [_SHA_A]


async def test_removes_project_dir_with_no_row_keeps_live_one(db):
    ws = Workspace(id="ws1", name={"en": "W"})
    db.add(ws)
    await db.commit()
    db.add(Project(uid="live", workspace_id="ws1", name={"en": "P"}))
    await db.commit()

    root = settings.data_path / "projects"
    (root / "live").mkdir(parents=True)
    (root / "live" / "keep.txt").write_text("data")
    (root / "ghost").mkdir(parents=True)
    (root / "ghost" / "junk.txt").write_text("junk")
    _age(root / "ghost", storage_gc.BLOB_MIN_AGE_SECONDS + 60)

    report = await storage_gc.sweep()

    assert (root / "live" / "keep.txt").exists()
    assert not (root / "ghost").exists()
    assert report.orphan_project_dirs == 1


async def test_spares_a_freshly_written_unreferenced_blob():
    # A blob lands on disk before the row referencing it is committed. Collecting
    # one that young would delete a file mid-import, so it must survive.
    in_flight = _make_blob(_SHA_B, age_seconds=5)

    report = await storage_gc.sweep()

    assert in_flight.exists()
    assert report.orphan_blobs == 0


async def test_spares_a_freshly_created_project_dir(db):
    ws = Workspace(id="ws1", name={"en": "W"})
    db.add(ws)
    await db.commit()

    new_dir = settings.data_path / "projects" / "being-created"
    new_dir.mkdir(parents=True)

    report = await storage_gc.sweep()

    assert new_dir.exists()
    assert report.orphan_project_dirs == 0


async def test_sweep_on_empty_data_dir_is_a_noop():
    report = await storage_gc.sweep()

    assert report.total_bytes == 0
    assert report.missing_blobs == []
