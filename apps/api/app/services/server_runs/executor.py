"""What every server run shares: its job, its claim, its checkpoint writes, its
heartbeat, its log, and the outcome it leaves when it ends.

Each attempt is a job of the panel; cancelling it pauses the run. A kind
(`registry`) subclasses `RunExecutor` with its `body`; one reading a database
subclasses `QueryingExecutor`, whose queries run in a process of the run's own
(`worker`) so that a query ignoring its interrupt can still be stopped.
"""

import asyncio
import contextlib
import json
import logging
import shutil
import traceback
from datetime import UTC, datetime
from pathlib import Path

from pydantic import ValidationError

from app.config import settings
from app.core import audit, database, deferred
from app.core.redact import scrub_row_values
from app.models.data_source import DataSource
from app.models.server_run import ServerRun
from app.models.user import User
from app.services import data_source_service, database_credential_service
from app.services.data import db_connect, query_cancel
from app.services.execution import jobs
from app.services.server_runs import state
from app.services.server_runs.watchdog import Watchdog
from app.services.server_runs.worker import (
    QueryFailed,
    QueryTimedOut,
    QueryWorker,
    runs_in_worker,
    to_the_end,
)

logger = logging.getLogger(__name__)

_tasks: dict[str, asyncio.Task] = {}

_ENDED_AS = {"done": "Done", "paused": "Paused", "cancelled": "Cancelled"}

# The server is stopping (a restart, a deploy): the runs it cuts are left going
# on, for the next process to take back (`runs.recover_on_startup`).
_shutting_down = False


def begin_shutdown() -> None:
    global _shutting_down
    _shutting_down = True


def shutting_down() -> bool:
    return _shutting_down


def runs_root() -> Path:
    return settings.data_path / "server-runs"


def run_dir(run_id: str) -> Path:
    """The run's own files (a frozen ranking, uploaded inputs, results)."""
    return runs_root() / run_id


def drop_files(run_id: str) -> None:
    shutil.rmtree(run_dir(run_id), ignore_errors=True)


async def forget_files(run_id: str) -> None:
    await asyncio.to_thread(drop_files, run_id)


def is_running(run_id: str) -> bool:
    task = _tasks.get(run_id)
    return task is not None and not task.done()


def stop(run_id: str) -> bool:
    """Cut a run's step in flight: its executor then records the pause."""
    task = _tasks.get(run_id)
    if task is None or task.done():
        return False
    task.cancel()
    return True


async def stop_and_wait(run_id: str, timeout: float = 10.0) -> None:
    """`stop`, then wait a while for the executor to have let go of its files."""
    task = _tasks.get(run_id)
    if stop(run_id) and task is not None:
        await asyncio.wait({task}, timeout=timeout)


async def launch(run: ServerRun, label: str) -> None:
    """A job for the run's next attempt, running its executor. Raises when the
    job cannot be made; the run, queued, is the caller's to end then."""
    from app.services.server_runs import registry

    async with database.async_session() as db:
        entity = await registry.KINDS[run.kind].entity(db, run)
        job = await jobs.create(
            db, None, run.user_id, kind="server_run", label=label[:255], workspace_id=run.workspace_id, entity=entity,
        )
        run_row = await db.get(ServerRun, run.id)
        if run_row is not None:
            run_row.job_id = job.id
            await db.commit()
    run_id = run.id

    async def body(handle: jobs.JobHandle) -> None:
        task = asyncio.current_task()
        assert task is not None
        _tasks[run_id] = task
        try:
            await execute(run_id, handle)
        finally:
            if _tasks.get(run_id) is task:
                _tasks.pop(run_id, None)

    jobs.launch(job.id, body, lane=None)


async def execute(run_id: str, handle: jobs.JobHandle) -> None:
    from app.services.server_runs import registry

    async with database.async_session() as db:
        attempt = await state.claim(db, run_id)
        if attempt is None:
            # Stopped before its turn, or taken by another job: this one did not run.
            raise asyncio.CancelledError
        run = await db.get(ServerRun, run_id)
        assert run is not None
        kind = registry.KINDS[run.kind]
        try:
            spec = kind.spec.model_validate(run.spec)
        except ValidationError as e:
            # Stored by an older server: the page starts it again.
            await state.write(db, run_id, attempt, status="failed", error=str(e)[:4000], finished_at=datetime.now(UTC))
            raise
        try:
            executor = await kind.executor.create(db, run, attempt, spec, handle)
        except Gone as e:
            await state.write(db, run_id, attempt, status="failed", error=str(e), finished_at=datetime.now(UTC))
            raise
        except asyncio.CancelledError:
            await to_the_end(_stopped_before_start(run_id, attempt))
            raise
        except Exception as e:  # noqa: BLE001 — no login (session-only, gone): its user resumes it
            error = scrub_row_values(str(getattr(e, "detail", e)))
            await state.write(db, run_id, attempt, status="interrupted", error=error, finished_at=datetime.now(UTC))
            raise
    await executor.run()


async def _stop_status(run_id: str) -> str | None:
    """What a run cut by a stop ends as: what its page asked — None while the
    server shuts down, the run left going on for the next process."""
    if _shutting_down:
        return None
    try:
        async with database.async_session() as db:
            asked = await state.requested(db, run_id)
    except Exception:  # noqa: BLE001 — unread, the run pauses: a resume loses nothing
        asked = None
    return "cancelled" if asked == "cancel" else "paused"


async def _stopped_before_start(run_id: str, attempt: int) -> None:
    status = await _stop_status(run_id)
    if status is None:
        return
    with contextlib.suppress(state.Fenced):
        async with database.async_session() as db:
            await state.write(db, run_id, attempt, status=status, requested=None, finished_at=datetime.now(UTC))


class Gone(Exception):
    """What the run reads no longer exists: it fails, there is nothing to resume."""


class RunExecutor:
    """One attempt of a run: `body` does the kind's work and keeps `state`, the
    checkpoint, which `save` writes fenced by the attempt. A pause or a cancel
    asked meanwhile is seen at `boundary`, or cuts the step in flight (`stop`)."""

    def __init__(self, run: ServerRun, attempt: int, spec, handle: jobs.JobHandle, launched_by: dict):
        self.run_id = run.id
        self.attempt = attempt
        self.spec = spec
        self.handle = handle
        self.state = dict(run.state or {})
        self.user_id = run.user_id
        self.scope_id = run.scope_id
        self.workspace_id = run.workspace_id
        self.launched_by = launched_by
        self.last_pct = -1
        self.last_steps: list[dict] | None = None

    @classmethod
    async def create(cls, db, run: ServerRun, attempt: int, spec, handle: jobs.JobHandle) -> "RunExecutor":
        """The executor of this attempt, with what it needs resolved now: a
        login that is not there raises, and the run waits for its user."""
        return cls(run, attempt, spec, handle, await launched_by(db, run.user_id))

    # --- the kind's part ----------------------------------------------------

    async def body(self) -> None:
        raise NotImplementedError

    def percent(self) -> int:
        """How far the run is, for the job's progress."""
        return 0

    def steps(self) -> list[dict] | None:
        """Its steps and how far each is (`JobStep`), for a run of several:
        the job lists them, the run's state keeps them for its page."""
        return None

    def start_note(self) -> str:
        return "Started" if self.attempt == 1 else "Resumed"

    async def setup(self) -> None:
        """Before the body, inside the run: what a stop must also end."""

    async def teardown(self) -> None:
        """After the body, whatever its end."""

    def ended(self, status: str) -> None:
        """The run's files go once nothing will resume it."""
        if status in ("done", "cancelled"):
            drop_files(self.run_id)

    # --- writes -------------------------------------------------------------

    async def save(self, **values) -> None:
        steps = self.steps()
        if steps is not None:
            self.state["steps"] = steps
        async with database.async_session() as db:
            await state.write(db, self.run_id, self.attempt, state=dict(self.state), **values)
        pct = self.percent()
        if pct != self.last_pct:
            self.last_pct = pct
            await self.handle.progress(pct)
        if steps is not None and steps != self.last_steps:
            self.last_steps = steps
            await self.handle.set_steps(steps)

    async def note(self, line: str) -> None:
        """A line of the job's output, timed."""
        await self.handle.log(f"{datetime.now().astimezone():%H:%M:%S}  {line}")

    # --- the run --------------------------------------------------------------

    async def run(self) -> None:
        heartbeat = asyncio.create_task(self._heartbeat())
        status: str | None = None
        error: str | None = None
        try:
            await self.note(self.start_note())
            await self.setup()
            await self.body()
            status = "done"
        except asyncio.CancelledError:
            status = "stopped"
            raise
        except state.Fenced:
            raise
        except Exception as e:  # noqa: BLE001 — any failure is the run's, shown on its page
            # Shown to every reader of the run, and logged: a row value it quotes is not.
            error = scrub_row_values(str(e))[:4000]
            # The frames, not the exception's own text: they name code, never a row value.
            logger.error(
                "server run %s failed: %s: %s\n%s", self.run_id, type(e).__name__, error,
                "".join(traceback.format_tb(e.__traceback__)),
            )
            status = "failed"
            raise
        finally:
            # One task to its end, whatever cancels this one meanwhile (a second
            # stop, the job's own cancel): a run must not stay `running` with no
            # executor because its last write was cut.
            await to_the_end(self._end(heartbeat, status, error))

    async def _end(self, heartbeat: asyncio.Task, status: str | None, error: str | None) -> None:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
        with contextlib.suppress(Exception):
            await self.teardown()
        if status == "stopped":
            status = await _stop_status(self.run_id)
        if status is None:
            return
        outcome = {"status": status, **({"error": error} if error is not None else {})}
        with contextlib.suppress(Exception):
            await self.note(_ENDED_AS.get(status) or f"Failed: {short_text(error or '')}")
        self.state.pop("current", None)
        try:
            await self.save(finished_at=datetime.now(UTC), requested=None, **outcome)
        except state.Fenced:
            return
        except Exception:  # noqa: BLE001 — left `running` with no task, read as interrupted (`runs.settled`)
            logger.error("server run %s: its outcome (%s) could not be written", self.run_id, status)
            return
        await asyncio.to_thread(self.ended, status)

    async def requested(self) -> str | None:
        async with database.async_session() as db:
            return await state.requested(db, self.run_id)

    async def _heartbeat(self) -> None:
        while True:
            await asyncio.sleep(state.LEASE_SECONDS / 3)
            with contextlib.suppress(state.Fenced):
                async with database.async_session() as db:
                    await state.write(db, self.run_id, self.attempt)

    async def boundary(self) -> None:
        """Between two steps: a pause asked meanwhile stops the run here."""
        if await self.requested() in ("pause", "cancel"):
            raise asyncio.CancelledError


async def launched_by(db, user_id: int) -> dict:
    user = await db.get(User, user_id)
    return {"user_id": user_id, **({"username": user.username} if user else {})}


class QueryingExecutor(RunExecutor):
    """A run reading one database (`run.data_source_id`) as its user. A database
    DuckDB reads itself is queried in a process of the run's own, which a stop
    always ends; an external one computes the queries itself, and
    `query_cancel` stops them there (`_InProcess`)."""

    def __init__(self, run, attempt, spec, handle, launched_by, source: DataSource, login, inputs):
        super().__init__(run, attempt, spec, handle, launched_by)
        self.source = source
        self.source_id = source.id
        self.login = login
        self.worker = QueryWorker(*inputs) if runs_in_worker(inputs[0]) else _InProcess(self)
        # What the attempts before learnt of the steps: a resume starts with it,
        # not with a first deadline of half an hour.
        learnt = self.state.get("learnt") or {}
        self.watchdog = Watchdog(**learnt.get("watchdog", {}))

    @classmethod
    async def create(cls, db, run, attempt, spec, handle):
        source = await data_source_service.get(db, run.data_source_id) if run.data_source_id else None
        if source is None:
            raise Gone("the database no longer exists")
        login = await database_credential_service.resolve_login(db, source, run.user_id)
        inputs = await data_source_service.materialize_inputs(db, source, login)
        return cls(run, attempt, spec, handle, await launched_by(db, run.user_id), source, login, inputs)

    async def setup(self) -> None:
        await self.worker.start()

    async def teardown(self) -> None:
        await asyncio.shield(self.worker.stop())

    def learnt(self) -> dict:
        """What to keep for the next attempt (`state.learnt`)."""
        w = self.watchdog
        return {"watchdog": {"srtt": w.srtt, "rttvar": w.rttvar, "rows": w.rows} if w.srtt is not None else {}}

    async def query(self, sql: str, what: str, *, deadline: float | None = None, pushdown: bool = True) -> list[dict]:
        """A query of the run, in the heavy lane — one heavy query at a time,
        whatever run asks — shown as the job's input under `what` it computes.
        `pushdown`: an external database may compute it; the worker reads only
        databases DuckDB reads itself, where it means nothing."""
        await self.handle.set_input(f"-- {what}\n{sql}")
        async with jobs.lane_slot("heavy_query"):
            # One access-log line per query, as through `/query`.
            with audit.job_scope(self.handle.job_id, "query", self.launched_by):
                if isinstance(self.worker, QueryWorker):
                    data_source_service.audit_use(self.source, "query", sql)
                    rows = await self.worker.run(sql, deadline=deadline)
                else:
                    rows = await self.worker.run(sql, deadline=deadline, pushdown=pushdown)
                audit.bind(row_count=len(rows))
        return rows


class _InProcess:
    """The worker's interface for a database DuckDB does not read itself: the
    query runs in the API, pushed down, and `query_cancel` stops it there."""

    def __init__(self, executor: QueryingExecutor):
        self.executor = executor

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        pass

    async def run(self, sql: str, *, deadline: float | None = None, pushdown: bool = True) -> list[dict]:
        ex = self.executor
        tag = cancel_tag(ex.handle.job_id, ex.user_id)
        token = query_cancel.current_query.set(tag)
        cap = db_connect.row_cap.set(db_connect.MAX_QUERY_ROWS_ALL)

        async def work() -> list[dict]:
            async with database.async_session() as db:
                source = await data_source_service.get(db, ex.source_id)
                if source is None:
                    raise ValueError("the database no longer exists")
                return await data_source_service.query(db, source, ex.login, sql, pushdown=pushdown)

        try:
            stoppable = deferred.until_stopped(work(), lambda: query_cancel.cancel(*tag))
            try:
                return await (asyncio.wait_for(stoppable, deadline) if deadline else stoppable)
            except TimeoutError:
                raise QueryTimedOut(deadline or 0) from None
            except (asyncio.CancelledError, QueryTimedOut):
                raise
            except Exception as e:  # noqa: BLE001 — a database's error is the step's, as the worker reports it
                raise QueryFailed(str(e), type(e).__name__) from e
        finally:
            query_cancel.current_query.reset(token)
            db_connect.row_cap.reset(cap)


# --- small helpers the kinds share ---------------------------------------------


def took(started: float) -> str:
    seconds = asyncio.get_running_loop().time() - started
    if seconds < 1:
        return f"{seconds * 1000:.0f} ms"
    if seconds < 60:
        return f"{seconds:.1f} s"
    return f"{int(seconds // 60)} min {int(seconds % 60):02d} s"


def short(error: Exception) -> str:
    """A database error's first line, fit for the job's log and the run's page,
    which others read: none of the row values it quotes."""
    return short_text(str(error)) or type(error).__name__


def short_text(text: str) -> str:
    lines = scrub_row_values(text).strip().splitlines()
    return lines[0][:300] if lines else ""


def cancel_tag(job_id: str, user_id: int) -> tuple[str, str]:
    """What `query_cancel` knows a run's query in flight by: its job, owned by the
    run's user, as a query job's is (`query_jobs`)."""
    return (f"job:{job_id}", str(user_id))


def now_iso() -> str:
    """An ISO instant as the browser writes one (`toISOString`)."""
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value))
    tmp.replace(path)


def read_json(path: Path):
    return json.loads(path.read_text())
