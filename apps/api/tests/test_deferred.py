"""core.deferred: work outliving its request is capped per user, and a failure
nobody polls is still retrieved (no "exception never retrieved")."""

import asyncio

import pytest
from fastapi import HTTPException

from app.core import deferred


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    monkeypatch.setattr(deferred, "_tasks", {})
    monkeypatch.setattr(deferred, "_running", {})
    monkeypatch.setattr(deferred, "WAIT_SECONDS", 0)


async def test_running_work_is_capped_per_user():
    gate = asyncio.Event()

    async def slow():
        await gate.wait()
        return "done"

    for _ in range(deferred.MAX_RUNNING_PER_USER):
        assert (await deferred.respond("alice", slow)).status_code == 202
    with pytest.raises(HTTPException) as exc:
        await deferred.respond("alice", slow)
    assert exc.value.status_code == 429
    # Another user is not held back by alice's work.
    assert (await deferred.respond("bob", slow)).status_code == 202

    gate.set()
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert deferred._running == {}
    assert (await deferred.respond("alice", slow)).status_code == 202


async def test_a_failure_nobody_polls_is_retrieved(monkeypatch):
    monkeypatch.setattr(deferred, "WAIT_SECONDS", 5)
    gate = asyncio.Event()

    async def failing():
        await gate.wait()
        raise ValueError("boom")

    request = asyncio.create_task(deferred.respond("alice", failing))
    await asyncio.sleep(0)
    request.cancel()  # the client disconnected before the wait ran out
    with pytest.raises(asyncio.CancelledError):
        await request

    loop = asyncio.get_running_loop()
    unretrieved: list[dict] = []
    loop.set_exception_handler(lambda _loop, ctx: unretrieved.append(ctx))
    gate.set()
    for _ in range(3):
        await asyncio.sleep(0)
    import gc

    gc.collect()
    assert deferred._running == {}
    assert not unretrieved
