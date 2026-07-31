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
