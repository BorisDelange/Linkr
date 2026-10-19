"""Job runner: create/run/complete, error capture, cancel, restart reconcile."""

import asyncio

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.job import Job
from app.models.project import Project
from app.models.workspace import Workspace
from app.models.user import User
from app.core.security import hash_password
from app.services.execution import jobs


@pytest.fixture(autouse=True)
async def _seed(db, engine, monkeypatch):
    # jobs.py writes via its own `async_session`; point it at the test engine so
    # its writes land in the same database the `db` fixture reads.
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(jobs, "async_session", maker)
    db.add(Workspace(id="ws1"))
    await db.flush()
    db.add(Project(uid="proj-1", workspace_id="ws1"))
    db.add(User(id=1, username="u", password_hash=hash_password("x"), role="user"))
    await db.commit()


async def _wait_settled(db, job_id: str) -> Job:
    """The job once its task has ended: the task writes its last status before."""
    task = jobs._tasks.get(job_id)
    if task is not None:
        await asyncio.gather(task, return_exceptions=True)
    job = await db.get(Job, job_id)
    await db.refresh(job)
    return job


async def test_job_runs_to_done(db):
    job = await jobs.create(db, "proj-1", 1, kind="build", label="Build")

    async def body(handle):
        await handle.log("hello")
        await handle.progress(50)

    jobs.launch(job.id, body)
    settled = await _wait_settled(db, job.id)
    assert settled.status == "done"
    assert settled.progress == 100
    assert "hello" in settled.log_tail


async def test_job_records_when_it_started_and_ended(db):
    job = await jobs.create(db, "proj-1", 1, kind="build", label="Build")
    assert job.started_at is None and job.finished_at is None

    async def body(handle):
        await asyncio.sleep(0.05)

    jobs.launch(job.id, body)
    settled = await _wait_settled(db, job.id)
    assert settled.started_at is not None
    assert settled.finished_at is not None
    assert settled.finished_at >= settled.started_at


async def test_log_has_no_blank_leading_line(db):
    """The first log entry must not leave an empty leading line in the panel."""
    job = await jobs.create(db, "proj-1", 1, kind="run", label="Run")

    async def body(handle):
        await handle.log("first")
        await handle.log("second")

    jobs.launch(job.id, body)
    settled = await _wait_settled(db, job.id)
    assert settled.log_tail == "first\nsecond"


async def test_log_strips_leading_blank_lines_of_first_entry(db):
    job = await jobs.create(db, "proj-1", 1, kind="run", label="Run")

    async def body(handle):
        await handle.log("\n\nfirst")

    jobs.launch(job.id, body)
    settled = await _wait_settled(db, job.id)
    assert settled.log_tail == "first"


async def test_job_body_failure_becomes_error(db):
    job = await jobs.create(db, "proj-1", 1, kind="build", label="Build")

    async def body(handle):
        raise RuntimeError("boom")

    jobs.launch(job.id, body)
    settled = await _wait_settled(db, job.id)
    assert settled.status == "error"
    assert "boom" in settled.log_tail


async def test_cancel_stops_a_running_job(db):
    job = await jobs.create(db, "proj-1", 1, kind="build", label="Build")
    started = asyncio.Event()

    async def body(handle):
        started.set()
        await asyncio.sleep(30)  # long — we cancel it

    jobs.launch(job.id, body)
    await started.wait()
    assert await jobs.cancel(db, job) is True
    settled = await _wait_settled(db, job.id)
    assert settled.status == "cancelled"


async def test_reconcile_marks_orphaned_running_as_error(db):
    job = await jobs.create(db, "proj-1", 1, kind="build", label="Build")
    job.status = "running"
    await db.commit()

    await jobs.reconcile_on_startup()
    await db.refresh(job)
    assert job.status == "error"
