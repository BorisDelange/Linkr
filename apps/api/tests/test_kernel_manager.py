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
        self.last_activity = time.monotonic()
        self.shut = False

    def idle_seconds(self):
        return time.monotonic() - self.last_activity

    async def shutdown(self):
        self.shut = True


@pytest.fixture
def mgr(monkeypatch):
    m = KernelManager()
    made: list[_FakeKernel] = []

    def _fake_make(language, project_uid):
        k = _FakeKernel()
        made.append(k)
        return k

    monkeypatch.setattr(m, "_make", _fake_make)
    m._made = made
    return m


async def test_per_user_cap(mgr, monkeypatch):
    monkeypatch.setattr(settings, "max_sessions_per_user", 2, raising=False)
    await mgr.get("p", "python", "e1", user_id=7)
    await mgr.get("p", "python", "e2", user_id=7)
    with pytest.raises(KernelLimitReached):
        await mgr.get("p", "python", "e3", user_id=7)
    # A different user is unaffected.
    await mgr.get("p", "python", "e1b", user_id=8)


async def test_idle_kernels_are_evicted(mgr, monkeypatch):
    monkeypatch.setattr(settings, "session_timeout_minutes", 60, raising=False)
    k = await mgr.get("p", "python", "e1", user_id=1)
    # Make it look idle beyond the timeout.
    k.last_activity = time.monotonic() - 3601
    # Next access sweeps it: a fresh kernel is created, the old one shut down.
    k2 = await mgr.get("p", "python", "e2", user_id=1)
    assert k.shut is True
    assert k2 is not k


async def test_busy_kernel_not_evicted(mgr, monkeypatch):
    monkeypatch.setattr(settings, "session_timeout_minutes", 60, raising=False)
    k = await mgr.get("p", "python", "e1", user_id=1)
    k.last_activity = time.monotonic() - 3601
    k.busy = True
    await mgr.get("p", "python", "e2", user_id=1)
    assert k.shut is False  # a running kernel is never swept


async def test_restart_frees_user_slot(mgr, monkeypatch):
    monkeypatch.setattr(settings, "max_sessions_per_user", 1, raising=False)
    await mgr.get("p", "python", "e1", user_id=1)
    await mgr.restart("p", "python", "e1")
    # Slot freed → can create again without hitting the cap.
    await mgr.get("p", "python", "e2", user_id=1)


def test_read_rss_kb_of_current_process():
    import os

    rss = kernel_mod._read_rss_kb(os.getpid())
    assert rss is None or rss > 0
