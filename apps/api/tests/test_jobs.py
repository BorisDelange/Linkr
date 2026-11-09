"""Job runner: create/run/complete, error capture, cancel, restart reconcile."""

import asyncio

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.security import hash_password
from app.models.job import Job
from app.models.project import Project
from app.models.user import User
from app.models.workspace import Workspace
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


async def test_live_log_shows_lines_while_the_body_runs(db):
    job = await jobs.create(db, "proj-1", 1, kind="build", label="Build")
    seen_midway = asyncio.Event()

    async def body(handle):
        async with jobs.live_log(handle, every=0.05) as on_log:
            on_log("Resolved 15 packages")
            for _ in range(50):
                await asyncio.sleep(0.02)
                row = await db.get(Job, job.id)
                await db.refresh(row)
                if row.log_tail == "Resolved 15 packages":
                    seen_midway.set()
                    break
            on_log("Installed 12 packages")
            raise RuntimeError("boom")

    jobs.launch(job.id, body)
    settled = await _wait_settled(db, job.id)
    assert seen_midway.is_set()
    # The last lines are written before the failure, then the failure itself.
    assert settled.log_tail == "Resolved 15 packages\nInstalled 12 packages\nboom"


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


async def _job(db, label: str, *, status: str = "done", minute: int, kind: str = jobs.QUERY_KIND, group: str | None = None) -> Job:
    from datetime import UTC, datetime

    job = await jobs.create(db, "proj-1", 1, kind=kind, label=label, group_key=group, group_label=group)
    job.status = status
    job.created_at = datetime(2026, 1, 1, 0, minute, tzinfo=UTC)
    await db.commit()
    return job


async def test_a_running_job_is_listed_however_many_rows_came_after_it(db, monkeypatch):
    await _job(db, "old running", status="running", minute=0)
    await _job(db, "old group done", minute=1, group="g")
    await _job(db, "old group running", status="queued", minute=2, group="g")
    await _job(db, "old done", minute=3)
    for i in range(3):
        await _job(db, f"new {i}", minute=10 + i)
    monkeypatch.setattr(jobs, "RECENT_JOBS", 2)

    labels = [j.label for j in await jobs.list_active(db, "proj-1", 1)]
    # Newest first; the old active job, and the whole group holding one, still listed.
    assert labels == ["new 2", "new 1", "old group running", "old group done", "old running"]


async def test_finished_queries_go_after_the_retention_the_others_stay(db, monkeypatch):
    from datetime import UTC, datetime, timedelta

    monkeypatch.setattr(jobs.settings, "query_log_hours", 24)
    now = datetime.now(UTC)
    for label, status, kind, age in [
        ("old query", "done", jobs.QUERY_KIND, 25), ("old failed query", "error", jobs.QUERY_KIND, 30),
        ("recent query", "done", jobs.QUERY_KIND, 23), ("old running query", "running", jobs.QUERY_KIND, 30),
        ("old build", "done", "build", 30),
    ]:
        job = await jobs.create(db, "proj-1", 1, kind=kind, label=label)
        job.status = status
        job.created_at = now - timedelta(hours=age)
        await db.commit()

    assert await jobs.purge_old_queries() == 2
    labels = {j.label for j in await jobs.list_active(db, "proj-1", 1)}
    assert labels == {"recent query", "old running query", "old build"}


async def _aged_job(db, kind, hours, *, status="done"):
    from datetime import UTC, datetime, timedelta

    when = datetime.now(UTC) - timedelta(hours=hours)
    job = await jobs.create(db, "proj-1", 1, kind=kind, label=f"{kind} {hours}", input="code")
    job.status, job.created_at, job.finished_at = status, when, when
    job.result, job.log_tail = {"table": [{"name": "DUMMY"}]}, "DUMMY"
    await db.commit()
    return job.id


async def _gone_from_disk(job_id: str) -> bool:
    from app.services.data import query_jobs

    return not query_jobs.results_dir(job_id).exists()


async def test_a_query_job_goes_with_its_result_files_past_the_retention(db, monkeypatch):
    from app.services.data import query_jobs

    monkeypatch.setattr(jobs.settings, "query_log_hours", 24)
    old, recent = await _aged_job(db, "query", 25), await _aged_job(db, "query", 2)
    for job_id in (old, recent):
        query_jobs.write_result(query_jobs.result_path(job_id, "k"), [{"name": "DUMMY"}])

    await jobs.purge_old_queries()

    assert await db.get(Job, old, populate_existing=True) is None and await _gone_from_disk(old)
    assert await db.get(Job, recent, populate_existing=True) is not None and not await _gone_from_disk(recent)


@pytest.mark.parametrize("kind", ["run", "etl", "derive"])
async def test_a_job_s_output_goes_past_the_retention_its_row_stays(db, monkeypatch, kind):
    monkeypatch.setattr(jobs.settings, "job_output_hours", 48)
    old, recent = await _aged_job(db, kind, 49), await _aged_job(db, kind, 47)
    build = await _aged_job(db, "build", 49)

    await jobs.purge_old_queries()

    kept = await db.get(Job, old, populate_existing=True)
    assert kept.result is None and not kept.log_tail and kept.input == "code"
    for job_id in (recent, build):
        job = await db.get(Job, job_id, populate_existing=True)
        assert job.result is not None and job.log_tail == "DUMMY"


async def test_a_running_job_keeps_its_result_files_however_old(db, monkeypatch):
    import os

    from app.services.data import query_jobs

    job_id = await _aged_job(db, "query", 72, status="running")
    query_jobs.write_result(query_jobs.result_path(job_id, "k"), [])
    old = 1_000_000_000
    os.utime(query_jobs.results_dir(job_id), (old, old))
    monkeypatch.setattr(jobs, "is_running", lambda i: i == job_id)

    await jobs.purge_old_queries()

    assert not await _gone_from_disk(job_id)


async def test_a_results_folder_nothing_claims_goes_while_the_server_runs(db):
    import os

    from app.services.data import query_jobs

    query_jobs.write_result(query_jobs.result_path("orphan", "k"), [])
    os.utime(query_jobs.results_dir("orphan"), (1_000_000_000, 1_000_000_000))

    await jobs.purge_old_queries()

    assert await _gone_from_disk("orphan")


async def test_a_job_s_error_keeps_values_out_of_its_row(db):
    job = await jobs.create(db, "proj-1", 1, kind=jobs.QUERY_KIND, label="q", running=True)

    async def failing():
        raise ValueError("Conversion Error: Could not convert string 'DUMMY-NAME' to INT32")

    task = asyncio.create_task(failing())
    await jobs.adopt(job.id, task, written=True)
    with pytest.raises(ValueError):
        await task
    await asyncio.gather(*jobs._status_writes)
    row = await db.get(Job, job.id, populate_existing=True)
    assert row.status == "error" and "DUMMY-NAME" not in row.log_tail and "Conversion Error" in row.log_tail


async def test_a_job_stopped_by_its_client_ends_cancelled(db):
    from app.core import deferred

    job = await jobs.create(db, "proj-1", 1, kind=jobs.QUERY_KIND, label="q", running=True)

    async def stopped():
        raise deferred.Stopped()

    task = asyncio.create_task(stopped())
    await jobs.adopt(job.id, task, written=True)
    await asyncio.gather(task, return_exceptions=True)
    await asyncio.gather(*list(jobs._status_writes), return_exceptions=True)
    await db.refresh(job)
    assert job.status == "cancelled"


async def test_a_project_job_is_its_projects_by_name(db):
    project = await db.get(Project, "proj-1")
    project.name = {"fr": "Projet", "en": "Project one"}
    await db.commit()
    job = await jobs.create(db, "proj-1", 1, kind="build", label="Build")
    assert (job.entity_type, job.entity_id, job.entity_name) == ("project", "proj-1", "Project one")


async def test_a_job_is_the_entity_its_request_works_on(db):
    token = jobs.current_entity.set(jobs.Entity("database", "db-1", "MIMIC"))
    try:
        job = await jobs.create(db, None, 1, kind="query", label="Q", workspace_id="ws1")
    finally:
        jobs.current_entity.reset(token)
    assert (job.entity_type, job.entity_id, job.entity_name) == ("database", "db-1", "MIMIC")
