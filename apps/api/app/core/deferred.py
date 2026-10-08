"""Requests that may outlive the gateway's read timeout.

A large dataset preview or import can take minutes, and the reverse proxy in
front of the API (nginx: 60 s by default) answers 504 long before — while the
work goes on, unseen. A route opts in by wrapping its work in ``respond``: when
the work finishes within ``WAIT_SECONDS`` the response is exactly what it would
have been; otherwise the route answers ``202`` with ``{"deferredTaskId": …}``, the work
keeps running, and the client polls
``GET /deferred/{id}`` until it gets the very response the route would have sent
(the frontend's ``apiRequest`` does this transparently).

State is in memory, like database compaction: the API runs a single worker. A
restart loses an unfinished task, and the poll then reads 404.

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

logger = logging.getLogger(__name__)

WAIT_SECONDS = 20.0
# A finished task nobody came back for is dropped after this long.
_KEEP_SECONDS = 600.0
# Work keeps running after its client gives up, so without a cap one user could
# pile up any number of multi-minute imports.
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


def _on_done(user_id: str, task: asyncio.Task) -> None:
    left = _running.get(user_id, 1) - 1
    if left > 0:
        _running[user_id] = left
    else:
        _running.pop(user_id, None)
    if task.cancelled():
        return
    # Retrieved here so a client that disconnected before the task was registered
    # (nobody will ever poll it) does not leave "exception never retrieved".
    exc = task.exception()
    if exc is not None and not any(e.task is task for e in _tasks.values()):
        logger.warning("Deferred work failed with no client waiting: %r", exc)


async def respond(user_id: str, work: Callable[[], Awaitable[Any]]) -> Any:
    """Run `work`; its result (or exception) if it ends within `WAIT_SECONDS`,
    else a 202 pointing at the task it keeps running as."""
    _sweep()
    if _running.get(user_id, 0) >= MAX_RUNNING_PER_USER:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many long-running requests in progress; wait for one to finish.",
        )
    _running[user_id] = _running.get(user_id, 0) + 1
    task = asyncio.create_task(work())
    task.add_done_callback(lambda t: _on_done(user_id, t))
    try:
        return await asyncio.wait_for(asyncio.shield(task), WAIT_SECONDS)
    except TimeoutError:
        task_id = uuid.uuid4().hex
        _tasks[task_id] = _Entry(user_id=user_id, task=task)
        return _pending_response(task_id)


def poll(user_id: str, task_id: str) -> Any:
    """The task's outcome once done — its result, or its exception re-raised so
    the poll answers with the status the route would have used. None when the id
    is unknown or belongs to someone else (the caller answers 404 either way)."""
    entry = _tasks.get(task_id)
    if entry is None or entry.user_id != user_id:
        return None
    if not entry.task.done():
        return _pending_response(task_id)
    _tasks.pop(task_id, None)
    exc = entry.task.exception()
    if exc is not None:
        raise exc
    return entry.task.result()
