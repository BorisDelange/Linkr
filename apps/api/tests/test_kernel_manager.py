"""KernelManager: idle-timeout eviction and per-user session cap. Uses a fake
kernel so no real interpreter subprocess is spawned."""

import time

import pytest

from app.config import settings
from app.services.execution import kernel as kernel_mod
from app.services.execution.kernel import KernelLimitReached, KernelManager


class _FakeKernel:
    def __init__(self):
        self.busy = False
        self.alive = True
        self.pid = 1234
        self.rss_kb = 5000
        self.last_activity = time.monotonic()
        self.shut = False
        self.interrupted = False

    def idle_seconds(self):
        return time.monotonic() - self.last_activity

    def interrupt(self):
        self.interrupted = True
        return True

    async def shutdown(self):
        self.shut = True


@pytest.fixture
def mgr(monkeypatch):
    m = KernelManager()
    made: list[_FakeKernel] = []

    def _fake_make(language, project_uid, environment=None):
        k = _FakeKernel()
        made.append(k)
        return k

    monkeypatch.setattr(m, "_make", _fake_make)
    m._made = made
    return m


async def test_per_user_cap(mgr, monkeypatch):
    monkeypatch.setattr(settings, "max_kernels_per_user", 2)
    await mgr.get("p", 7, "python", "e1")
    await mgr.get("p", 7, "python", "e2")
    with pytest.raises(KernelLimitReached):
        await mgr.get("p", 7, "python", "e3")
    # A different user is unaffected.
    await mgr.get("p", 8, "python", "e1b")


async def test_idle_kernels_are_evicted(mgr, monkeypatch):
    monkeypatch.setattr(settings, "session_timeout_minutes", 60, raising=False)
    k = await mgr.get("p", 1, "python", "e1")
    # Make it look idle beyond the timeout.
    k.last_activity = time.monotonic() - 3601
    # Next access sweeps it: a fresh kernel is created, the old one shut down.
    k2 = await mgr.get("p", 1, "python", "e2")
    assert k.shut is True
    assert k2 is not k


async def test_busy_kernel_not_evicted(mgr, monkeypatch):
    monkeypatch.setattr(settings, "session_timeout_minutes", 60, raising=False)
    k = await mgr.get("p", 1, "python", "e1")
    k.last_activity = time.monotonic() - 3601
    k.busy = True
    await mgr.get("p", 1, "python", "e2")
    assert k.shut is False  # a running kernel is never swept


async def test_restart_frees_user_slot(mgr, monkeypatch):
    monkeypatch.setattr(settings, "max_kernels_per_user", 1)
    await mgr.get("p", 1, "python", "e1")
    await mgr.restart("p", 1, "python", "e1")
    # Slot freed → can create again without hitting the cap.
    await mgr.get("p", 1, "python", "e2")


async def test_same_env_different_users_are_isolated(mgr):
    # Two users sharing the same env id must get DISTINCT kernels (never share a
    # namespace).
    ka = await mgr.get("p", 1, "python", "default")
    kb = await mgr.get("p", 2, "python", "default")
    assert ka is not kb


async def test_list_for_user_hides_other_users(mgr):
    await mgr.get("p", 1, "python", "default")
    await mgr.get("p", 2, "python", "default")
    mine = mgr.list_for_user("p", 1)
    assert len(mine) == 1


def test_read_rss_kb_of_current_process():
    import os

    rss = kernel_mod._read_rss_kb(os.getpid())
    assert rss is None or rss > 0


async def test_interrupt_signals_the_live_kernel(mgr):
    k = await mgr.get("p", 1, "python", "e1")
    assert mgr.interrupt("p", 1, "python", "e1") is True
    assert k.interrupted is True


async def test_interrupt_is_a_noop_without_a_live_kernel(mgr):
    assert mgr.interrupt("p", 1, "python", "missing") is False


# --- Warm pool + ephemeral runs -------------------------------------------

class _RunKernel:
    """Fake kernel that records the code it ran and whether it was shut down."""

    def __init__(self):
        self.alive = True
        self.shut = False
        self.ran: list[str] = []

    async def execute(self, code, query_resolver=None):
        self.ran.append(code)
        from app.services.execution.runtime import RuntimeOutput

        return RuntimeOutput(stdout="ok", stderr="", figures=[], table=None, html=None)

    async def shutdown(self):
        self.shut = True
        self.alive = False


@pytest.fixture
def warm(monkeypatch):
    from app.services.execution.kernel import WarmPool

    pool = WarmPool()
    made: list[_RunKernel] = []

    def make():
        k = _RunKernel()
        made.append(k)
        return k

    return pool, make, made


async def test_warm_acquire_runs_bootstrap_and_refill_tops_up(warm, monkeypatch):
    pool, make, made = warm
    # An empty pool → acquire makes + warms one inline (runs the bootstrap import).
    k = await pool.acquire(make, "python", "p", "int")
    assert k in made
    assert k.ran and "import" in k.ran[0]  # warm bootstrap ran
    # Refill tops the bucket back up to pool_size in the background.
    await pool.refill(make, "python", "p", "int", pool_size=2)
    # A subsequent acquire hands out a pooled (already-warmed) process, not a fresh make.
    before = len(made)
    k2 = await pool.acquire(make, "python", "p", "int")
    assert len(made) == before  # reused from the pool, no new spawn
    assert k2 is not k


async def test_refill_fills_to_pool_size_and_no_overshoot(warm):
    pool, make, made = warm
    import asyncio

    # Two concurrent refills for the same bucket must not each spawn the full
    # shortfall — the reservation counter caps the total at pool_size.
    await asyncio.gather(
        pool.refill(make, "python", "p", "int", pool_size=4),
        pool.refill(make, "python", "p", "int", pool_size=4),
    )
    assert len(pool._pools[("python", "p", "int")]) == 4
    assert len(made) == 4  # exactly 4 spawned, not 8


async def test_acquire_waits_for_in_flight_warm_instead_of_cold_starting(warm):
    pool, make, made = warm
    import asyncio

    # A refill is warming 2 processes; concurrently two acquires come in on the same
    # empty bucket. They must WAIT for the warming ones (reserved > 0) and reuse them,
    # not each spawn a fresh cold process — that's the serial-widgets fix.
    async def slow_make():
        # simulate a cold start so the acquires arrive while warming is in flight
        k = _RunKernel()
        made.append(k)
        return k

    refill_task = asyncio.create_task(
        pool.refill(lambda: made.append(_RunKernel()) or made[-1], "python", "p", "int", pool_size=2)
    )
    await asyncio.sleep(0)  # let refill reserve
    a, b = await asyncio.gather(
        pool.acquire(slow_make, "python", "p", "int"),
        pool.acquire(slow_make, "python", "p", "int"),
    )
    await refill_task
    # Exactly 2 processes were ever made (the 2 warmed), reused by the 2 acquires —
    # the acquires did NOT cold-start a 3rd/4th of their own.
    assert len(made) == 2
    assert a in made and b in made and a is not b


async def test_run_ephemeral_discards_process_and_refills(warm, monkeypatch):
    pool, make, made = warm
    monkeypatch.setattr(kernel_mod, "warm_pool", pool)
    monkeypatch.setattr(kernel_mod.manager, "spawn_batch", lambda language, project_uid, environment=None: make())
    monkeypatch.setattr(settings, "widget_pool_size", 1, raising=False)
    monkeypatch.setattr(settings, "widget_max_concurrency", 4, raising=False)

    out = await kernel_mod.run_ephemeral("python", "p", "print(1)", environment=None)
    assert out.stdout == "ok"
    # The run's process ran the user code AND was shut down (never reused → no
    # namespace leak between widgets).
    ran_kernel = next(k for k in made if "print(1)" in k.ran)
    assert ran_kernel.shut is True
    # The refill task is scheduled in the background; give it a turn to run.
    import asyncio

    await asyncio.sleep(0)
    await asyncio.sleep(0)
