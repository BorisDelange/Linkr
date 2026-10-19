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


async def _workspace(client) -> tuple[dict, str, int]:
    await client.post("/api/v1/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post("/api/v1/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    headers = {"Authorization": f"Bearer {r.json()['access_token']}"}
    ws = (await client.post("/api/v1/workspaces", headers=headers, json={"name": {"en": "W"}})).json()["id"]
    me = (await client.get("/api/v1/auth/me", headers=headers)).json()["id"]
    return headers, ws, me


async def _ended(task_id: str) -> None:
    """The deferred work has ended, and so has the write of its job's last status."""
    from app.services.execution import jobs

    await asyncio.gather(deferred._tasks[task_id].task, return_exceptions=True)
    await asyncio.gather(*jobs._status_writes, return_exceptions=True)


async def _status(client, headers, ws, job_id, want, tries=100):
    """The job's status once it reads `want` — its end is written a beat after the task's."""
    for _ in range(tries):
        listed = (await client.get(f"/api/v1/workspaces/{ws}/jobs", headers=headers)).json()
        status_ = next(j for j in listed if j["id"] == job_id)["status"]
        if status_ == want:
            break
        await asyncio.sleep(0.02)
    return status_


async def test_long_work_becomes_a_job_of_the_panel_that_cancels_it(client):
    from app.services.execution import jobs

    headers, ws, me = await _workspace(client)
    gate = asyncio.Event()

    async def slow():
        await gate.wait()
        return {"ok": True}

    pending = await deferred.respond(str(me), slow, deferred.AsJob("Export", workspace_id=ws, lane="heavy_query"))
    assert pending.status_code == 202
    task_id = __import__("json").loads(pending.body)["deferredTaskId"]
    listed = (await client.get(f"/api/v1/workspaces/{ws}/jobs", headers=headers)).json()
    job = next(j for j in listed if j["id"] == task_id)
    assert job["kind"] == "task" and job["label"] == "Export" and job["status"] == "running"

    assert jobs.is_running(task_id)
    assert (await client.post(f"/api/v1/jobs/{task_id}/cancel", headers=headers)).status_code == 204
    await _ended(task_id)
    with pytest.raises(HTTPException) as exc:
        deferred.poll(str(me), task_id)
    assert exc.value.status_code == 499
    assert await _status(client, headers, ws, task_id, "cancelled") == "cancelled"


async def test_a_job_that_ends_hands_its_result_to_the_poll(client):
    headers, ws, me = await _workspace(client)
    gate = asyncio.Event()

    async def slow():
        await gate.wait()
        return {"ok": True}

    pending = await deferred.respond(str(me), slow, deferred.AsJob("Export", workspace_id=ws))
    task_id = __import__("json").loads(pending.body)["deferredTaskId"]
    gate.set()
    await _ended(task_id)
    assert deferred.poll(str(me), task_id) == {"ok": True}
    assert await _status(client, headers, ws, task_id, "done") == "done"


async def test_work_waiting_in_its_lane_shows_queued_until_it_has_its_slot(client, monkeypatch):
    from app.config import settings
    from app.services.execution import jobs

    monkeypatch.setattr(settings, "max_heavy_queries", 1)
    headers, ws, me = await _workspace(client)
    gate = asyncio.Event()

    async def slow():
        await gate.wait()
        return {"ok": True}

    slot = jobs.lane_slot("heavy_query")
    await slot.acquire()  # a heavy job holds the lane
    pending = await deferred.respond(str(me), slow, deferred.AsJob("Export", workspace_id=ws, lane="heavy_query"))
    task_id = __import__("json").loads(pending.body)["deferredTaskId"]
    assert await _status(client, headers, ws, task_id, "queued", tries=5) == "queued"

    slot.release()
    assert await _status(client, headers, ws, task_id, "running") == "running"
    gate.set()
    await _ended(task_id)
    assert deferred.poll(str(me), task_id) == {"ok": True}
    assert await _status(client, headers, ws, task_id, "done") == "done"


async def test_until_stopped_waits_for_the_stopped_work_to_end():
    ended = asyncio.Event()
    stop = asyncio.Event()

    async def query():
        # Like a DuckDB thread: a cancel does not reach it, only `stop` does.
        try:
            await asyncio.shield(stop.wait())
        finally:
            ended.set()
        raise RuntimeError("interrupted")

    caller = asyncio.create_task(deferred.until_stopped(query(), stop.set))
    await asyncio.sleep(0)
    caller.cancel()
    with pytest.raises(asyncio.CancelledError):
        await caller
    assert ended.is_set()
