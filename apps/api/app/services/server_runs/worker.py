"""A process of its own for a run's queries, so that a stop always ends them.

DuckDB's `interrupt()` is cooperative, and on 1.5.5 some queries never honour it
(duckdb#24961, #26720); one sent before its statement starts is lost, the flag
being reset as a query starts. In the API such a query stays in its thread and
keeps the database's pooled connection. A server-owned run sends its queries to a
child process instead, which can always be stopped: interrupted, then SIGTERM,
then SIGKILL (`QueryWorker.run`).

The child opens its connection once, as the pooled path of its engine does
(`db_connect._source_setup`, the same lock-down, every query through
`_run_isolated`: the SQL is the client's), and spills into a directory of its own.
Two pipes per child: the work pipe carries a query and its reply; the control
pipe, read by a thread of the child, what must reach it while a query runs
(interrupt, progress, its CPU time).

A query can also hang without being slow: on 1.5.5 a window function sometimes
loses the wakeup of its source (duckdb#26720), every thread of the database then
idle and the query waiting for ever. The child's CPU time tells it: a query whose
process works no more for `stall_after_s` is stopped as stalled (`QueryStalled`),
without waiting for its deadline. Never a shared `multiprocessing.Queue`: a process killed
while using one can leave it corrupted for every other.

External databases keep the in-process path (`runs_in_worker`): their queries are
pushed down to the database, and `query_cancel` stops them there.
"""

import asyncio
import contextlib
import importlib
import itertools
import multiprocessing
import os
import shutil
import signal
import threading
import time
import uuid
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from multiprocessing.connection import Connection
from multiprocessing.process import BaseProcess
from pathlib import Path

import duckdb

from app.config import settings
from app.services.data import db_connect
from app.services.data.db_schemas import _ATTACH_ALIAS

INTERRUPT_GRACE_S = 10.0
TERM_GRACE_S = 5.0
# An interrupt landing between two statements, or before the first, is lost.
INTERRUPT_EVERY_S = 0.5
SETUP_TIMEOUT_S = 120.0
_PROGRESS_WAIT_S = 1.0
# A query whose process spent less CPU than this over `stall_after_s` is stalled:
# a hung DuckDB sleeps, one reading or computing does not.
STALL_AFTER_S = 30.0
STALL_CPU_S = 0.1
STALL_CHECK_S = 5.0
_EXIT_POLL_S = 0.05
# After SIGKILL: a process in uninterruptible sleep is then left to the kernel.
_KILL_WAIT_S = 5.0

_EOF = ("eof",)

# The spill directories this process's children use; `_sweep_orphans` keeps them.
_live_temp_dirs: set[Path] = set()


class WorkerError(Exception):
    pass


class QueryFailed(WorkerError):
    """The query raised; the worker is still there. `kind` is the exception's
    class in the child (`ValueError` for a statement the guard refuses,
    `OutOfMemoryException`…)."""

    def __init__(self, message: str, kind: str = ""):
        super().__init__(message)
        self.kind = kind


class QueryTimedOut(WorkerError):
    def __init__(self, seconds: float):
        super().__init__(f"the query ran past its {seconds:.0f} s deadline and was stopped")
        self.seconds = seconds


class QueryStalled(WorkerError):
    def __init__(self, seconds: float):
        super().__init__(f"the query stopped working for {seconds:.0f} s (a hang of the database engine) and was stopped")
        self.seconds = seconds


class _Stalled(Exception):
    pass


class WorkerDied(WorkerError):
    """The child ended on its own (a crash, the OOM killer) with a query in flight."""


class SetupFailed(WorkerError):
    """The child could not open the database."""


def runs_in_worker(config: dict) -> bool:
    """Whether a database's queries can go to a `QueryWorker`: the ones DuckDB
    reads itself (Parquet folders, DuckDB and SQLite files)."""
    return config.get("engine") not in db_connect.EXTERNAL_ENGINES


def temp_root() -> Path:
    return settings.data_path / "_query_workers"


@dataclass(eq=False)
class _Child:
    process: BaseProcess
    work: Connection
    control: Connection
    replies: asyncio.Queue
    temp_dir: Path
    # Sends, and the closing of the pipes, which `_read_replies` does once the
    # child is gone: a pipe closed mid-send could see its descriptor reused.
    send_lock: threading.Lock = field(default_factory=threading.Lock)
    # One question at a time on the control pipe, which carries their answers.
    ask_lock: threading.Lock = field(default_factory=threading.Lock)
    discarded: bool = False

    @property
    def alive(self) -> bool:
        return not self.discarded and self.process.exitcode is None


class QueryWorker:
    """One child process answering a run's queries over one connection to its
    database. `run` calls are served one at a time.

    `config, password, files, known` are `data_source_service._materialize_inputs`'s.
    `prepare` ("module:function") is called in the child with its connection once
    it is locked down — a test hook. The graces are the ladder's (`run`)."""

    def __init__(
        self,
        config: dict,
        password: str | None,
        files: list[tuple[str, str]] | None,
        known: list[str] | None,
        *,
        threads: int | None = None,
        prepare: str | None = None,
        interrupt_grace_s: float = INTERRUPT_GRACE_S,
        term_grace_s: float = TERM_GRACE_S,
        stall_after_s: float = STALL_AFTER_S,
    ):
        if not runs_in_worker(config):
            raise ValueError(f"{config.get('engine')} queries run in the API process, not in a worker")
        self._inputs = (config, password, files, known)
        self._threads = threads
        self._prepare = prepare
        self._interrupt_grace_s = interrupt_grace_s
        self._term_grace_s = term_grace_s
        self._stall_after_s = stall_after_s
        self._child: _Child | None = None
        self._lock = asyncio.Lock()
        self._ids = itertools.count(1)

    @property
    def alive(self) -> bool:
        return self._child is not None and self._child.alive

    async def start(self) -> None:
        """Spawn the child and open the database, unless it is already up.
        Raises SetupFailed."""
        async with self._lock:
            if not self.alive:
                await self._spawn()

    async def run(self, sql: str, *, deadline: float | None = None, arrow: bool = False):
        """`sql`'s rows, JSON-ready as `/query` answers them, or with `arrow` a
        pyarrow Table. A dead child is replaced first.

        `deadline`: seconds the query may run, None for no limit. Past it, or when
        the awaiting task is cancelled, the query is stopped by a ladder: the
        interrupt, sent again every INTERRUPT_EVERY_S; still running after
        `interrupt_grace_s`, SIGTERM to the child's process group; `term_grace_s`
        later, SIGKILL. A child killed so is replaced at the next call. Then
        QueryTimedOut, or the CancelledError, is raised — unless the query ended
        with its rows as its deadline passed. QueryStalled: its process stopped
        working (module docstring), stopped by the same ladder. QueryFailed: the
        query raised. WorkerDied: the child ended on its own meanwhile."""
        async with self._lock:
            child = self._child if self.alive else await self._spawn()
            req = next(self._ids)
            try:
                _send(child, child.work, ("run", req, sql, arrow))
            except OSError:
                # It died after its last reply: the query never reached it.
                await self._kill(child)
                child = await self._spawn()
                _send(child, child.work, ("run", req, sql, arrow))
            try:
                async with asyncio.timeout(deadline):
                    reply = await self._watched(child, req)
            except TimeoutError:
                reply = await _to_the_end(self._stop_query(child, req))
                if reply is None or reply[0] != "ok":
                    raise QueryTimedOut(deadline or 0) from None
            except _Stalled:
                reply = await _to_the_end(self._stop_query(child, req))
                if reply is None or reply[0] != "ok":
                    raise QueryStalled(self._stall_after_s) from None
            except asyncio.CancelledError:
                await _to_the_end(self._stop_query(child, req))
                raise
            if reply is _EOF:
                await self._kill(child)
                raise WorkerDied(f"the query process ended unexpectedly (exit code {child.process.exitcode})")
        if reply[0] == "ok":
            return reply[2]
        raise QueryFailed(reply[2], reply[3])

    async def progress(self) -> float | None:
        """How much of its data the query in flight has read, in percent; None
        when none runs or DuckDB cannot tell (see query_cancel.progress)."""
        child = self._child
        if child is None or not child.alive:
            return None
        return await asyncio.to_thread(_ask, child, "progress", next(self._ids))

    async def stop(self) -> None:
        """End the child: asked to exit, killed when a query keeps it past
        `term_grace_s` (a run in flight then raises WorkerDied). Its spill
        directory goes with it."""
        child = self._child
        if child is None:
            return
        await _to_the_end(self._end(child))

    # --- the child's life ---------------------------------------------------

    async def _spawn(self) -> _Child:
        if self._child is not None:
            await self._kill(self._child)
        await asyncio.to_thread(_sweep_orphans)
        ctx = multiprocessing.get_context("spawn")
        work, child_work = ctx.Pipe()
        control, child_control = ctx.Pipe()
        temp_dir = temp_root() / f"{os.getpid()}-{uuid.uuid4().hex}"
        _live_temp_dirs.add(temp_dir)
        spec = {
            "inputs": self._inputs,
            "threads": self._threads,
            "prepare": self._prepare,
            "data_dir": str(settings.data_path),
            "memory_limit": db_connect.memory_limit(),
            "temp_dir": str(temp_dir),
        }
        process = ctx.Process(
            target=_child_main, args=(spec, child_work, child_control), name="linkr-query-worker", daemon=True,
        )
        child = _Child(process, work, control, asyncio.Queue(), temp_dir)
        self._child = child
        threading.Thread(
            target=_read_replies, args=(child, asyncio.get_running_loop()), name="query-worker-replies", daemon=True,
        ).start()
        try:
            try:
                await _to_the_end(asyncio.to_thread(process.start))
            finally:
                # Else the child's death would never read as EOF here.
                child_work.close()
                child_control.close()
            try:
                async with asyncio.timeout(SETUP_TIMEOUT_S):
                    ready = await child.replies.get()
            except TimeoutError:
                raise SetupFailed(f"the database did not open within {SETUP_TIMEOUT_S:.0f} s") from None
            if ready is _EOF:
                raise SetupFailed(f"the query process ended while opening the database (exit code {process.exitcode})")
            if ready[0] != "ready":
                raise SetupFailed(ready[2])
        except BaseException:
            await _to_the_end(self._kill(child))
            raise
        return child

    async def _watched(self, child: _Child, req: int) -> tuple:
        """The query's reply; _Stalled once its process has spent less than
        STALL_CPU_S of CPU over the last `stall_after_s`."""
        loop = asyncio.get_running_loop()
        every = min(STALL_CHECK_S, self._stall_after_s / 3)
        seen: deque[tuple[float, float]] = deque()
        while True:
            try:
                async with asyncio.timeout(every):
                    return await self._reply(child, req)
            except TimeoutError:
                pass
            cpu = await asyncio.to_thread(_ask, child, "cpu", next(self._ids))
            if cpu is None:
                continue
            now = loop.time()
            seen.append((now, cpu))
            # The oldest sample kept is the last one at least the window old.
            while len(seen) > 1 and now - seen[1][0] >= self._stall_after_s:
                seen.popleft()
            if now - seen[0][0] >= self._stall_after_s and cpu - seen[0][1] < STALL_CPU_S:
                raise _Stalled

    async def _reply(self, child: _Child, req: int) -> tuple:
        while True:
            msg = await child.replies.get()
            if msg is _EOF or msg[1] == req:
                return msg

    async def _stop_query(self, child: _Child, req: int) -> tuple | None:
        """The ladder (`run`); the query's reply when it came in time."""
        loop = asyncio.get_running_loop()
        give_up = loop.time() + self._interrupt_grace_s
        while (left := give_up - loop.time()) > 0:
            _send_control(child, ("interrupt", req))
            try:
                async with asyncio.timeout(min(INTERRUPT_EVERY_S, left)):
                    reply = await self._reply(child, req)
            except TimeoutError:
                continue
            if reply is _EOF:
                await self._kill(child)
                return None
            return reply
        await self._kill(child)
        return None

    async def _end(self, child: _Child) -> None:
        with contextlib.suppress(OSError):
            _send(child, child.work, ("exit",))
        if await _exited(child.process, self._term_grace_s):
            self._discard(child)
        else:
            await self._kill(child)

    async def _kill(self, child: _Child) -> None:
        _signal_group(child.process, signal.SIGTERM)
        if not await _exited(child.process, self._term_grace_s):
            _signal_group(child.process, signal.SIGKILL)
            await _exited(child.process, _KILL_WAIT_S)
        self._discard(child)

    def _discard(self, child: _Child) -> None:
        if self._child is child:
            self._child = None
        if child.discarded:
            return
        child.discarded = True
        shutil.rmtree(child.temp_dir, ignore_errors=True)
        _live_temp_dirs.discard(child.temp_dir)


async def _to_the_end[T](work: Awaitable[T]) -> T:
    """Await `work` to its end even when the task is cancelled meanwhile, then
    raise the cancel: a stop or a kill left half done would leave a child behind."""
    task = asyncio.ensure_future(work)
    cancelled = False
    while True:
        try:
            result = await asyncio.shield(task)
            break
        except asyncio.CancelledError:
            if task.done():
                raise
            cancelled = True
    if cancelled:
        raise asyncio.CancelledError
    return result


async def _exited(process: BaseProcess, timeout: float) -> bool:
    if process.pid is None:
        return True
    end = time.monotonic() + timeout
    while process.exitcode is None:
        if time.monotonic() >= end:
            return False
        await asyncio.sleep(_EXIT_POLL_S)
    return True


def _signal_group(process: BaseProcess, sig: int) -> None:
    if process.pid is None or process.exitcode is not None:
        return
    try:
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        # Not yet its own group leader (killed before its setsid).
        with contextlib.suppress(ProcessLookupError):
            os.kill(process.pid, sig)
    except PermissionError:
        pass


def _send(child: _Child, pipe: Connection, msg: tuple) -> None:
    with child.send_lock:
        pipe.send(msg)


def _send_control(child: _Child, msg: tuple) -> None:
    with contextlib.suppress(OSError):
        _send(child, child.control, msg)


def _ask(child: _Child, kind: str, ref: int) -> float | None:
    """The child's answer to `kind` ("progress", "cpu"), None when it gives none in time."""
    with child.ask_lock:
        try:
            _send_control(child, (kind, ref))
            end = time.monotonic() + _PROGRESS_WAIT_S
            while (left := end - time.monotonic()) > 0 and child.control.poll(left):
                _, got, value = child.control.recv()
                if got == ref:
                    return value
        except (OSError, EOFError, ValueError):
            pass
    return None


def _read_replies(child: _Child, loop: asyncio.AbstractEventLoop) -> None:
    """Hand the child's replies to the event loop, a large Arrow table read off
    it; EOF is how its end shows. Then close its pipes, which only this thread
    may do: another thread closing one under its `recv` would leave it reading
    whatever pipe gets the descriptor next."""
    while True:
        try:
            msg = child.work.recv()
        except Exception:  # noqa: BLE001 — EOF, or a reply that cannot be read: the child must go
            msg = _EOF
        with contextlib.suppress(RuntimeError):
            loop.call_soon_threadsafe(child.replies.put_nowait, msg)
        if msg is _EOF:
            break
    with child.ask_lock, child.send_lock:
        child.work.close()
        child.control.close()


def _sweep_orphans() -> None:
    """Remove the spill directories no child of a live API process uses: a crash
    or a kill of the API skips their cleanup, and they can hold gigabytes. A
    restarted container may reuse the API's pid, hence the set of our own."""
    root = temp_root()
    if not root.is_dir():
        return
    for entry in root.iterdir():
        pid = entry.name.partition("-")[0]
        if not pid.isdigit() or entry in _live_temp_dirs:
            continue
        if int(pid) == os.getpid() or not _pid_alive(int(pid)):
            shutil.rmtree(entry, ignore_errors=True)


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


# --- the child ------------------------------------------------------------------


class _Running:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.con: duckdb.DuckDBPyConnection | None = None
        self.req: int | None = None


def _child_main(spec: dict, work: Connection, control: Connection) -> None:
    # Its own process group, which the kill ladder signals whole.
    os.setsid()
    running = _Running()
    threading.Thread(target=_listen, args=(control, running), name="control", daemon=True).start()
    try:
        con, search_path = _connect(spec)
    except Exception as exc:  # noqa: BLE001 — told to the parent, which raises SetupFailed
        with contextlib.suppress(OSError):
            work.send(("setup_failed", None, str(exc) or type(exc).__name__))
        return
    running.con = con
    db_connect.row_cap.set(db_connect.MAX_QUERY_ROWS_ALL)
    work.send(("ready", None))
    while True:
        try:
            msg = work.recv()
        except (EOFError, OSError):
            break
        if msg[0] == "exit":
            break
        _, req, sql, arrow = msg
        reply = _answer(con, running, search_path, req, sql, arrow)
        try:
            work.send(reply)
        except OSError:
            break
        except Exception as exc:  # noqa: BLE001 — pickling fails before a byte is written
            work.send(("error", req, f"the result could not be sent back: {exc}", type(exc).__name__))
    con.close()


def _connect(spec: dict) -> tuple[duckdb.DuckDBPyConnection, Callable[[duckdb.DuckDBPyConnection], str]]:
    """The child's connection, locked down, and what to call before each query
    for its search path."""
    # The parent's view, which a test may have patched since the environment was read.
    settings.data_dir = spec["data_dir"]
    settings.__dict__.pop("data_path", None)
    settings.duckdb_memory_limit = spec["memory_limit"] or ""
    setup, search_path, readable = db_connect._source_setup(*spec["inputs"])
    temp_dir = Path(spec["temp_dir"])
    shutil.rmtree(temp_dir, ignore_errors=True)
    temp_dir.mkdir(parents=True)
    con = setup()
    con.execute(f"SET temp_directory = '{db_connect._sql_path(temp_dir.as_posix())}'")
    if spec["threads"]:
        con.execute(f"SET threads = {int(spec['threads'])}")
    db_connect._forbid_file_access(con, readable)
    db_connect._lock_down_user_sql(con)
    if spec["prepare"]:
        module, _, name = spec["prepare"].partition(":")
        getattr(importlib.import_module(module), name)(con)
    if readable:
        return con, search_path
    return con, _attached_file_search_path


def _attached_file_search_path(con: duckdb.DuckDBPyConnection) -> str:
    """As `query_file` reads a file: its stored views and macros checked on each
    query, since it may change under the connection, and its schemas read again."""
    db_connect._reject_stored_passthrough(con, [_ATTACH_ALIAS])
    return db_connect._file_search_path(con)


def _answer(
    con: duckdb.DuckDBPyConnection, running: _Running, search_path: Callable[[duckdb.DuckDBPyConnection], str],
    req: int, sql: str, arrow: bool,
) -> tuple:
    with running.lock:
        running.req = req
    try:
        reply = ("ok", req, db_connect._run_isolated(con, search_path(con), sql, arrow))
    except Exception as exc:  # noqa: BLE001 — the query's error is the reply
        reply = ("error", req, str(exc), type(exc).__name__)
    finally:
        with running.lock:
            running.req = None
    if reply[0] == "error":
        _reset(con)
    return reply


def _reset(con: duckdb.DuckDBPyConnection) -> None:
    """An interrupt landing on `_run_isolated`'s own ROLLBACK leaves its
    transaction open, and its variables set: the next query could not begin."""
    with contextlib.suppress(duckdb.Error):
        con.execute("ROLLBACK")
    with contextlib.suppress(duckdb.Error):
        for (name,) in con.execute("SELECT name FROM duckdb_variables()").fetchall():
            con.execute(f"RESET VARIABLE {db_connect._quote_ident(name)}")


def _listen(control: Connection, running: _Running) -> None:
    while True:
        try:
            kind, ref = control.recv()
        except (EOFError, OSError):
            # The API is gone: nobody is left to answer, and the database is held for nothing.
            os._exit(1)
        if kind == "interrupt":
            with running.lock:
                if running.con is not None and running.req == ref:
                    running.con.interrupt()
        elif kind == "progress":
            value = None
            if running.con is not None:
                with contextlib.suppress(Exception):
                    value = running.con.query_progress()
            with contextlib.suppress(OSError):
                control.send(("progress", ref, value if value is not None and value > 0 else None))
        elif kind == "cpu":
            # The whole process, every thread of the database's included.
            with contextlib.suppress(OSError):
                control.send(("cpu", ref, time.process_time()))
