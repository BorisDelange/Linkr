"""Tracked long-running jobs with a bounded in-process executor (step 4).

A job is a DB row (``Job``) plus a live asyncio task. Tasks run behind a
semaphore so a burst can't exhaust the single uvicorn worker; excess jobs sit
``queued`` until a slot frees. No external broker (celery/RQ) — the DB-backed
model means a real queue can replace this runner later without a schema change.

Cancellation cancels the asyncio task; a well-behaved job body (see the uv build,
which runs `uv sync` as a subprocess) turns that CancelledError into killing its
child process. On server restart, jobs left ``running`` (their task is gone) are
reconciled to ``error`` at startup — the row survives, the process does not.
"""

import asyncio

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.database import async_session
from app.models.job import Job

# Live tasks by job id, so cancel() can reach a running job's asyncio.Task.
_tasks: dict[str, asyncio.Task] = {}
_semaphore: asyncio.Semaphore | None = None


def _sem() -> asyncio.Semaphore:
    # Built lazily on first use so it binds to the running loop, and reads the
    # configured cap (max_build_concurrency) at that point.
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(settings.max_build_concurrency)
    return _semaphore


async def create(
    db: AsyncSession, project_uid: str, user_id: int, kind: str, label: str
) -> Job:
    job = Job(
        project_uid=project_uid, user_id=user_id, kind=kind, label=label, status="queued"
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return job


def launch(job_id: str, body) -> None:
    """Schedule a job body (an async callable receiving a JobHandle). Runs behind
    the semaphore; records status/log/progress transitions in its own DB session."""
    _tasks[job_id] = asyncio.create_task(_run(job_id, body))


async def run_now(job_id: str, body) -> None:
    """Run a job body and AWAIT it (still tracked + visible + cancellable via the
    same task registry). Used for auto-build on first run, where the triggering
    request must block until the env is ready."""
    task = asyncio.create_task(_run(job_id, body))
    _tasks[job_id] = task
    await task


async def _run(job_id: str, body) -> None:
    handle = JobHandle(job_id)
    try:
        async with _sem():
            await _set(job_id, status="running")
            await body(handle)
            await _set(job_id, status="done", progress=100)
    except asyncio.CancelledError:
        await _set(job_id, status="cancelled")
        raise
    except Exception as e:  # a job body failure is the job's error, not a 500
        await handle.log(str(e))
        await _set(job_id, status="error")
    finally:
        _tasks.pop(job_id, None)


class JobHandle:
    """Passed to a job body so it can append to the log and report progress
    without owning a DB session."""

    def __init__(self, job_id: str):
        self.job_id = job_id

    async def log(self, line: str) -> None:
        async with async_session() as db:
            job = await db.get(Job, self.job_id)
            if job is None:
                return
            # Keep only the tail so a chatty build doesn't bloat the row.
            tail = (job.log_tail + "\n" + line).splitlines()[-200:]
            job.log_tail = "\n".join(tail)
            await db.commit()

    async def progress(self, pct: int) -> None:
        await _set(self.job_id, progress=max(0, min(100, pct)))


async def _set(job_id: str, **fields) -> None:
    async with async_session() as db:
        await db.execute(update(Job).where(Job.id == job_id).values(**fields))
        await db.commit()


async def cancel(db: AsyncSession, job: Job) -> bool:
    """Cancel a live job. Returns False if it already finished (nothing to do)."""
    task = _tasks.get(job.id)
    if task is None or task.done():
        return False
    task.cancel()
    return True


async def list_active(db: AsyncSession, project_uid: str, user_id: int) -> list[Job]:
    """A user's non-terminal jobs for a project (queued/running) plus recently
    finished ones, newest first — feeds the StatusBar panel."""
    result = await db.execute(
        select(Job)
        .where(Job.project_uid == project_uid)
        .where(Job.user_id == user_id)
        .order_by(Job.created_at.desc())
        .limit(20)
    )
    return list(result.scalars().all())


async def reconcile_on_startup() -> None:
    """A job left running/queued when the process died has no task anymore → mark
    it error so the panel doesn't show a phantom 'running' forever."""
    async with async_session() as db:
        await db.execute(
            update(Job)
            .where(Job.status.in_(("running", "queued")))
            .values(status="error", log_tail="Interrupted by server restart")
        )
        await db.commit()
