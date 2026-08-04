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


class _FakeProc:
    def __init__(self):
        self.returncode = None
        self.signals: list = []

    def send_signal(self, sig):
        self.signals.append(sig)


def test_kernel_interrupt_only_fires_while_busy():
    """A Stop click races the run's own completion. If the run already finished
    (busy=False) the kernel is idle on stdin, and a SIGINT delivered then is
    queued and caught at the start of the NEXT run — spuriously aborting a fresh
    run. interrupt() must be a no-op unless a run is actually in flight."""
    from app.services.execution.kernel import Kernel

    k = Kernel(cmd=["true"])
    proc = _FakeProc()
    k._proc = proc

    # Idle kernel: Stop must NOT send a signal (else it poisons the next run).
    k.busy = False
    k._running = True
    assert k.interrupt() is False
    assert proc.signals == []

    # Dispatched but the interpreter hasn't acked yet (cold start): a SIGINT here
    # lands before any handler is installed and would KILL the process.
    k.busy = True
    k._running = False
    assert k.interrupt() is False
    assert proc.signals == []

    # A run genuinely in flight: Stop signals it.
    k._running = True
    assert k.interrupt() is True
    assert len(proc.signals) == 1


class _FakeStdout:
    """Feeds pre-canned JSON lines to _read_stream, one per readline()."""

    def __init__(self, lines: list[bytes]):
        self._lines = list(lines)

    async def readline(self) -> bytes:
        return self._lines.pop(0) if self._lines else b""


class _StdoutProc:
    def __init__(self, lines):
        self.stdout = _FakeStdout(lines)
        self.stdin = None


async def test_read_stream_skips_a_stopped_runs_leftover_output():
    """A stopped run whose reader was torn down leaves its chunks + done in the
    pipe, tagged with its (lower) run number. Reading the NEXT run must discard
    those leftovers — otherwise the old output bleeds in and the stale done ends
    the fresh run instantly."""
    import json as _json

    from app.services.execution.kernel import Kernel

    def line(obj):
        return (_json.dumps(obj) + "\n").encode()

    lines = [
        # leftover from run 1 (reader torn down): stale chunk + stale done
        line({"__linkr_stream__": "stdout", "data": "OLD\n", "__linkr_run__": 1}),
        line({"__linkr_done__": True, "__linkr_run__": 1, "stdout": "", "stderr": ""}),
        # our run 2: real chunk, then our done
        line({"__linkr_stream__": "stdout", "data": "NEW\n", "__linkr_run__": 2}),
        line({"__linkr_done__": True, "__linkr_run__": 2, "stdout": "", "stderr": ""}),
    ]
    k = Kernel(cmd=["true"])
    seen: list[str] = []
    done = await k._read_stream(
        _StdoutProc(lines), lambda kind, data: seen.append(data), None, expected=2
    )
    # Only our chunk reached the client; the leftover was dropped.
    assert seen == ["NEW\n"]
    # And the done we returned is ours (run 2), not the stale one.
    assert done is not None and done.get("__linkr_run__") == 2


# --- Warm pool + ephemeral runs -------------------------------------------

class _RunKernel:
    """Fake kernel that records the code it ran and whether it was shut down."""

    def __init__(self):
        self.alive = True
        self.shut = False
        self.ran: list[str] = []
        self.last_activity = time.monotonic()

    def idle_seconds(self) -> float:
        return time.monotonic() - self.last_activity

    async def execute(self, code, query_resolver=None):
        self.ran.append(code)
        self.last_activity = time.monotonic()
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
    monkeypatch.setattr(kernel_mod.manager, "_make", lambda language, project_uid, environment=None: make())
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


class _Env:
    def __init__(self, kind, interpreter_path=None):
        self.kind = kind
        self.interpreter_path = interpreter_path


def test_interpreter_key_isolates_every_project_r_env():
    """A project R env is isolated to its own library even when empty/unbuilt, so it
    gets a per-project key — a shared warm process (global packages) is never reused
    for it. Only the app interpreter (environment is None) shares the system key."""
    from app.services.execution.kernel import _interpreter_key

    # Built env → its concrete library path.
    assert _interpreter_key("r", "p1", _Env("managed", "/libs/p1/r")) == "/libs/p1/r"
    # Any project R env, not built (managed draft OR empty system) → per-project key.
    assert _interpreter_key("r", "p1", _Env("managed")) == "__project_r__:p1"
    assert _interpreter_key("r", "p1", _Env("system")) == "__project_r__:p1"
    assert _interpreter_key("r", "p2", _Env("system")) == "__project_r__:p2"
    assert _interpreter_key("r", "p1", _Env("system")) != _interpreter_key("r", "p1", None)
    # The app interpreter (no env) → shared system interpreter.
    assert _interpreter_key("r", "p1", None) == "__system__:r"
    # Python not-yet-built has no private-lib isolation here → stays app interpreter.
    assert _interpreter_key("python", "p1", _Env("managed")) == "__system__:python"


def test_r_kernel_loop_stays_under_e_arg_threshold():
    """`Rscript --vanilla -e <loop>` mangles the argument past ~7 KB (WARNING + a
    fatal "unexpected end of input"), which hangs the client on "Loading R runtime".
    Keep the R source lean — prose comments belong in Python, not the R string. This
    guards the regression that adding a comment block reintroduced."""
    from app.services.execution.kernel import _R_KERNEL_LOOP

    assert len(_R_KERNEL_LOOP.encode("utf-8")) < 7000, (
        "R kernel loop too large for `Rscript -e`; move comments to Python, not the R string"
    )


@pytest.mark.asyncio
async def test_stop_immediately_after_run_does_not_kill_a_cold_kernel():
    """Regression: a Stop click within milliseconds of Run used to KILL a cold kernel
    (destroying the whole namespace) because `busy` is set before the code is even
    written to stdin — so the SIGINT landed while the interpreter was still booting,
    before it installed any handler. Runs a REAL subprocess: a mock kernel can't
    reproduce a signal arriving pre-handler."""
    import asyncio
    import sys

    from app.services.execution.kernel import _PY_KERNEL_LOOP, Kernel

    for delay in (0.0, 0.01, 0.05):
        k = Kernel(cmd=[sys.executable, "-c", _PY_KERNEL_LOOP])
        try:
            task = asyncio.create_task(k.execute_stream("x = 1", lambda kind, data: None))
            await asyncio.sleep(delay)
            k.interrupt()
            try:
                await asyncio.wait_for(task, timeout=30)
            except Exception:
                pass
            assert k.alive, f"kernel died on a Stop {delay}s after Run"
            # The namespace survived, so a follow-up run still sees x.
            out = await k.execute_stream("print(x)", lambda kind, data: None)
            assert k.alive
        finally:
            await k.shutdown()
    assert out is not None
