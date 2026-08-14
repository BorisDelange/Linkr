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
    # Age the CONTENTS as well: a dir is aged by its newest descendant, so a
    # freshly-written file inside keeps the whole tree out of reach (which is
    # what protects a live project whose work all happens in subdirectories).
    _age(root / "ghost" / "junk.txt", storage_gc.BLOB_MIN_AGE_SECONDS + 60)
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


async def test_spares_a_blob_stored_from_an_OLD_assembled_upload():
    """The grace period must count from the STORE, not from the upload.

    `shutil.move` preserves mtime, so a blob assembled from a slow multi-GB
    upload used to land already hours old and was collectable on the very next
    sweep — while the user was still on the import dialog and no row referenced
    it yet. Goes through the real `store_file`; building the blob by hand (as
    the sibling tests do) cannot catch this, which is how it shipped.
    """
    from app.services import blob_store

    src = settings.data_path / "_assembled"
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_bytes(b"z" * 128)
    _age(src, storage_gc.BLOB_MIN_AGE_SECONDS * 2)  # a long, slow upload

    sha, _ = await blob_store.store_file(src)
    blob = blob_store.path_for(sha)

    report = await storage_gc.sweep()

    assert blob.exists(), "a just-stored blob was collected as if it were old"
    assert report.orphan_blobs == 0


async def test_re_storing_existing_content_refreshes_its_grace_period():
    """The dedup branch keeps the original file, so nothing would move its mtime.

    Re-uploading content is exactly the signal "this blob is live again": without
    the touch, content whose last reference was just deleted comes back with an
    already-expired grace period and dies on the next sweep.
    """
    from app.services import blob_store

    first = settings.data_path / "_a1"
    first.parent.mkdir(parents=True, exist_ok=True)
    first.write_bytes(b"dedup me")
    sha, _ = await blob_store.store_file(first)
    blob = blob_store.path_for(sha)
    _age(blob, storage_gc.BLOB_MIN_AGE_SECONDS * 2)  # now stale and unreferenced

    second = settings.data_path / "_a2"
    second.write_bytes(b"dedup me")  # same content -> dedup branch
    again, _ = await blob_store.store_file(second)

    assert again == sha
    report = await storage_gc.sweep()

    assert blob.exists(), "a re-uploaded blob was collected despite being re-referenced"
    assert report.orphan_blobs == 0


async def test_spares_a_project_dir_whose_work_is_in_subdirectories(db):
    """A dir's own mtime ignores writes inside its subdirectories.

    Every real project writes into scripts/ and datasets/, so reading the top
    dir's mtime reported a project in daily use as untouched since its creation
    — and the 1-hour guard never protected any of them.
    """
    ws = Workspace(id="ws-sub", name={"en": "W"})
    db.add(ws)
    await db.commit()

    d = settings.data_path / "projects" / "orphan-but-active"
    (d / "scripts").mkdir(parents=True)
    _age(d / "scripts", storage_gc.BLOB_MIN_AGE_SECONDS * 3)
    _age(d, storage_gc.BLOB_MIN_AGE_SECONDS * 3)
    # The dir looks ancient; a file deep inside was written seconds ago.
    (d / "scripts" / "etl.sql").write_text("SELECT 1")

    report = await storage_gc.sweep()

    assert d.exists(), "an actively-used project tree was deleted"
    assert report.orphan_project_dirs == 0


async def test_refuses_to_sweep_every_project_dir_when_the_db_has_none():
    """No live projects + populated projects/ is a misconfiguration, not garbage.

    A restored snapshot or a mispointed LINKR_DATABASE_URL would otherwise wipe
    every working tree on the next startup sweep.
    """
    root = settings.data_path / "projects"
    for name in ("p1", "p2"):
        d = root / name
        d.mkdir(parents=True)
        (d / "keep.txt").write_text("precious")
        _age(d, storage_gc.BLOB_MIN_AGE_SECONDS * 3)

    report = await storage_gc.sweep()

    assert (root / "p1" / "keep.txt").exists()
    assert (root / "p2" / "keep.txt").exists()
    assert report.orphan_project_dirs == 0


async def test_spares_a_freshly_created_project_dir(db):
    ws = Workspace(id="ws1", name={"en": "W"})
    db.add(ws)
    await db.commit()

    new_dir = settings.data_path / "projects" / "being-created"
    new_dir.mkdir(parents=True)

    report = await storage_gc.sweep()

    assert new_dir.exists()
    assert report.orphan_project_dirs == 0


async def test_collects_a_leaked_tmp_blob_but_spares_a_fresh_one():
    """`store_bytes` writes `<sha>.tmp` then renames; a crash in between leaks it.

    `is_sha` rightly excludes `.tmp` from the blob set, which also meant no sweep
    ever collected one — it stayed on disk for good.
    """
    d = settings.data_path / "_files"
    d.mkdir(parents=True, exist_ok=True)
    stale = d / f"{_SHA_A}.tmp"
    stale.write_bytes(b"x" * 8)
    _age(stale, storage_gc.BLOB_MIN_AGE_SECONDS + 60)
    fresh = d / f"{_SHA_B}.tmp"
    fresh.write_bytes(b"y" * 8)  # a write still in flight

    report = await storage_gc.sweep()

    assert not stale.exists()
    assert fresh.exists(), "a .tmp being written right now must not be collected"
    assert report.orphan_blobs == 1


async def test_missing_blobs_is_capped_but_the_total_stays_exact(db):
    """An unmounted volume makes EVERY referenced sha missing.

    Uncapped, that put hundreds of thousands of 64-char strings into one JSON
    response. The sample is what you debug with; the count is what tells you the
    store is gone.
    """
    db.add(Workspace(id="ws1", name={"en": "W"}))
    await db.commit()
    db.add(Project(uid="p1", workspace_id="ws1", name={"en": "P"}))
    await db.commit()

    n = storage_gc.MAX_MISSING_BLOBS_REPORTED + 25
    for i in range(n):
        db.add(DatasetFile(id=f"f{i}", project_uid="p1", name="d", type="file",
                           data_sha=f"{i:064x}"))
    await db.commit()

    # Nothing on disk at all — the store never existed.
    report = await storage_gc.sweep()

    assert report.missing_blobs_total == n
    assert len(report.missing_blobs) == storage_gc.MAX_MISSING_BLOBS_REPORTED


async def test_sweep_on_empty_data_dir_is_a_noop():
    report = await storage_gc.sweep()

    assert report.total_bytes == 0
    assert report.missing_blobs == []
