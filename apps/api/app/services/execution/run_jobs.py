"""Run a script server-side as a tracked background job (batch mode).

Unlike an interactive run (which reuses the session's live kernel + namespace),
a run-as-job spawns a FRESH process: an empty namespace, so it's a reproducible
batch execution. Output streams into the job's log tail as it's produced; figures
and a result table are collected at the end and stored on the job (``Job.result``),
so they're viewable from the jobs panel even after the user leaves the file.

The job runs behind the same bounded executor as env builds and is cancellable
(cancelling the task shuts the kernel subprocess down).
"""

import asyncio

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.database import async_session
from app.models.job import Job
from app.services.execution import environments, jobs, kernel


async def start(
    db: AsyncSession, project_uid: str, user_id: int, language: str, code: str, label: str
) -> Job:
    """Create + launch a background run job. Returns the queued job immediately;
    the panel shows progress and, on completion, the collected figures/table."""
    # Make sure the env is built before the batch process starts (auto-build on
    # first run), so the fresh kernel resolves the project's packages.
    await environments.ensure_ready(db, project_uid, language, user_id)
    env = await environments.resolve(db, project_uid, language)

    job = await jobs.create(db, project_uid, user_id, kind="run", label=label)

    async def body(handle: jobs.JobHandle) -> None:
        k = kernel.manager.spawn_batch(language, project_uid, env)
        # Buffer streamed chunks and flush them to the log tail periodically, so a
        # chatty run doesn't hammer the DB with one write per line.
        buffer: list[str] = []

        def on_chunk(_kind: str, data: str) -> None:
            buffer.append(data)

        try:
            # Overall wall-clock cap: the kernel's per-readline timeout doesn't bound
            # total runtime (a chatty loop resets it every line), so a runaway job
            # would pin a build-concurrency slot forever. wait_for kills it; the
            # finally shuts the subprocess down and the raise marks the job 'error'.
            try:
                out = await asyncio.wait_for(
                    k.execute_stream(code, on_chunk), timeout=settings.job_timeout_seconds
                )
            except asyncio.TimeoutError:
                if buffer:
                    await handle.log("".join(buffer).rstrip("\n"))
                raise RuntimeError(
                    f"Job exceeded the {settings.job_timeout_seconds}s time limit and was stopped."
                )
            text = "".join(buffer) + (out.stderr or "")
            if text.strip():
                await handle.log(text.rstrip("\n"))
            await _store_result(job.id, out)
        finally:
            await k.shutdown()

    jobs.launch(job.id, body)
    return job


async def _store_result(job_id: str, out) -> None:
    """Persist the batch run's artifacts on the job row so the panel can show them."""
    async with async_session() as db:
        job = await db.get(Job, job_id)
        if job is None:
            return
        job.result = {
            "figures": out.figures or [],
            "table": out.table,
            "html": out.html,
        }
        await db.commit()
