"""One user's burst of work stays within bounds that leave room for everyone
else: a few run at once, the rest wait their turn holding nothing, and a burst
past the ceiling is refused at once rather than after the wait."""

import asyncio
import threading
import weakref

import pytest
from fastapi import HTTPException

from app.core import deferred


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    monkeypatch.setattr(deferred, "_tasks", {})
    monkeypatch.setattr(deferred, "_running", {})
    monkeypatch.setattr(deferred, "_in_flight", {})
    monkeypatch.setattr(deferred, "_user_slots", weakref.WeakKeyDictionary())
    monkeypatch.setattr(deferred, "WAIT_SECONDS", 0.05)


async def _burst(user: str, n: int, gate: asyncio.Event, running: list[str]) -> list[asyncio.Task]:
    async def slow():
        running.append(user)
        try:
            await gate.wait()
        finally:
            running.remove(user)
        return "done"

    tasks = [asyncio.create_task(deferred.respond(user, slow)) for _ in range(n)]
    await asyncio.sleep(0.01)
    return tasks


async def test_a_burst_past_the_ceiling_is_refused_at_once():
    gate, running = asyncio.Event(), []
    admitted = await _burst("alice", deferred.MAX_IN_FLIGHT_PER_USER, gate, running)
    with pytest.raises(HTTPException) as exc:
        await asyncio.wait_for(deferred.respond("alice", gate.wait), 0.01)
    assert exc.value.status_code == 429
    gate.set()
    await asyncio.gather(*admitted)


async def test_only_a_few_of_one_user_s_works_run_at_once_and_others_still_run():
    gate, running = asyncio.Event(), []
    alice = await _burst("alice", deferred.MAX_CONCURRENT_PER_USER + 3, gate, running)
    assert running.count("alice") == deferred.MAX_CONCURRENT_PER_USER
    bob = await _burst("bob", 1, gate, running)
    assert running.count("bob") == 1
    gate.set()
    await asyncio.gather(*alice, *bob)
    for _ in range(5):
        await asyncio.sleep(0)
    assert deferred._in_flight == {}


async def test_a_page_s_few_quick_queries_all_answer():
    async def quick():
        return "rows"

    results = await asyncio.gather(*(deferred.respond("alice", quick) for _ in range(deferred.MAX_CONCURRENT_PER_USER * 2)))
    assert results == ["rows"] * (deferred.MAX_CONCURRENT_PER_USER * 2)


async def test_one_user_s_blocked_queries_leave_the_default_executor_free():
    from app.services import data_source_service

    release = threading.Event()
    blocked = [
        asyncio.create_task(data_source_service.in_query_thread(release.wait))
        for _ in range(64)
    ]
    try:
        assert await asyncio.wait_for(asyncio.to_thread(lambda: "free"), 2) == "free"
    finally:
        release.set()
        await asyncio.gather(*blocked)
