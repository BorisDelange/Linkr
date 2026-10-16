"""Requests that may outlive the gateway's read timeout.

A large dataset preview or import can take minutes, and the reverse proxy in
front of the API (nginx: 60 s by default) answers 504 long before — while the
work goes on, unseen. A route opts in by wrapping its work in ``respond``: when
the work finishes within ``WAIT_SECONDS`` the response is exactly what it would
have been; otherwise the route answers ``202`` with ``{"deferredTaskId": …}``, the work
keeps running, and the client polls
``GET /deferred/{id}`` until it gets the very response the route would have sent
(the frontend's ``apiRequest`` does this transparently).

A route that names an owner (a project or a workspace) and a label also gets
its long work into the ``jobs`` table once it outlives ``WAIT_SECONDS``: it shows
in the jobs panel, and cancelling it there cancels the work — the poll then reads
the cancellation (499). The 202 then points at the job's id. A heavy route also
names a lane, so its work waits for its turn behind the jobs of that lane (two
heavy DuckDB queries never run together).

State is in memory: the API runs a single worker. A restart loses an unfinished
task (its job, if any, is reconciled to an error), and the poll then reads 404.

The work must not use the request's DB session — the session closes when the
first response is sent. Check permissions before calling ``respond``.
"""

import asyncio
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, status
from fastapi.responses import JSONResponse

from app.core.database import async_session

logger = logging.getLogger(__name__)

WAIT_SECONDS = 20.0
# A finished task nobody came back for is dropped after this long.
_KEEP_SECONDS = 600.0
# Work keeps running after its client gives up, so without a cap one user could
# pile up any number of multi-minute imports. Counts the work past WAIT_SECONDS.
MAX_RUNNING_PER_USER = 4


@dataclass
class _Entry:
    user_id: str
    task: asyncio.Task
    finished_at: float | None = None


_tasks: dict[str, _Entry] = {}
_running: dict[str, int] = {}


def _pending_response(task_id: str) -> JSONResponse:
    # A key no route body uses, so the client cannot mistake a real 202 for it.
    return JSONResponse({"deferredTaskId": task_id}, status_code=202)


def _sweep() -> None:
    now = time.monotonic()
    for task_id, entry in list(_tasks.items()):
        if entry.task.done():
            if entry.finished_at is None:
                entry.finished_at = now
            elif now - entry.finished_at > _KEEP_SECONDS:
                _tasks.pop(task_id, None)


def _release(user_id: str) -> None:
    left = _running.get(user_id, 1) - 1
    if left > 0:
        _running[user_id] = left
    else:
        _running.pop(user_id, None)


def _on_done(task: asyncio.Task) -> None:
    if task.cancelled():
        return
    # Retrieved here so a client that disconnected before the task was registered
    # (nobody will ever poll it) does not leave "exception never retrieved".
    exc = task.exception()
    if exc is not None and not any(e.task is task for e in _tasks.values()):
        logger.warning("Deferred work failed with no client waiting: %r", exc)


def session():
    """A session of the work's own: the request's closes with the first response."""
    return async_session()


@dataclass(frozen=True)
class AsJob:
    """How long work shows in the jobs panel: its owner (exactly one of a project
    and a workspace), its label, and the lane it waits in (None: it starts at once)."""

    label: str
    project_uid: str | None = None
    workspace_id: str | None = None
    lane: str | None = None
    # What the work runs (a query's SQL), shown with the job.
    input: str | None = None


async def respond(user_id: str, work: Callable[[], Awaitable[Any]], as_job: AsJob | None = None) -> Any:
    """Run `work`; its result (or exception) if it ends within `WAIT_SECONDS`,
    else a 202 pointing at the task it keeps running as — a job of the panel when
    `as_job` says how."""
    from app.services.execution import jobs

    _sweep()
    if _running.get(user_id, 0) >= MAX_RUNNING_PER_USER:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many long-running requests in progress; wait for one to finish.",
        )

    async def run() -> Any:
        if as_job is None or as_job.lane is None:
            return await work()
        async with jobs.lane_slot(as_job.lane):
            return await work()

    task = asyncio.create_task(run())
    task.add_done_callback(_on_done)
    try:
        return await asyncio.wait_for(asyncio.shield(task), WAIT_SECONDS)
    except TimeoutError:
        # Only long work counts against the cap: every query goes through here,
        # and a page firing a few at once must not be refused.
        _running[user_id] = _running.get(user_id, 0) + 1
        task.add_done_callback(lambda _: _release(user_id))
        task_id = uuid.uuid4().hex
        # An entity outside any project and workspace (a user's own settings) has
        # no panel to show in: it stays a plain deferred request.
        if as_job is not None and (as_job.project_uid or as_job.workspace_id):
            task_id = await _as_job(user_id, task, as_job)
        _tasks[task_id] = _Entry(user_id=user_id, task=task)
        return _pending_response(task_id)


async def _as_job(user_id: str, task: asyncio.Task, as_job: AsJob) -> str:
    """Record running work as a job of the panel; its status follows the task."""
    from app.services.execution import jobs

    async with session() as db:
        job = await jobs.create(
            db, as_job.project_uid, int(user_id), "task", as_job.label, workspace_id=as_job.workspace_id,
            input=as_job.input,
        )
    job_id = job.id
    await jobs.adopt(job_id, task)
    return job_id


def poll(user_id: str, task_id: str) -> Any:
    """The task's outcome once done — its result (None included), or its
    exception re-raised so the poll answers with the status the route would have
    used. 404 when the id is unknown or belongs to someone else."""
    entry = _tasks.get(task_id)
    if entry is None or entry.user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown or expired task")
    if not entry.task.done():
        return _pending_response(task_id)
    _tasks.pop(task_id, None)
    if entry.task.cancelled():
        # Cancelled from the jobs panel: nobody else could.
        raise HTTPException(499, "The task was cancelled")
    exc = entry.task.exception()
    if exc is not None:
        raise exc
    return entry.task.result()
