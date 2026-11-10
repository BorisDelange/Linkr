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
from datetime import UTC, datetime
from pathlib import Path

from app.config import settings
from app.core import audit, database, deferred
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
)

logger = logging.getLogger(__name__)

_tasks: dict[str, asyncio.Task] = {}

_ENDED_AS = {"done": "Done", "paused": "Paused", "cancelled": "Cancelled"}


def run_dir(run_id: str) -> Path:
    """The run's own files (a frozen ranking, uploaded inputs, results)."""
    return settings.data_path / "server-runs" / run_id


def drop_files(run_id: str) -> None:
    shutil.rmtree(run_dir(run_id), ignore_errors=True)


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


async def launch(run: ServerRun, label: str) -> None:
    """A job for the run's next attempt, running its executor."""
    from app.services.server_runs import registry

    async with database.async_session() as db:
        entity = await registry.KINDS[run.kind].entity(db, run)
        job = await jobs.create(
            db, None, run.user_id, kind="server_run", label=label, workspace_id=run.workspace_id, entity=entity,
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
            return
        run = await db.get(ServerRun, run_id)
        assert run is not None
        kind = registry.KINDS[run.kind]
        spec = kind.spec.model_validate(run.spec)
        try:
            executor = await kind.executor.create(db, run, attempt, spec, handle)
        except Gone as e:
            await state.write(db, run_id, attempt, status="failed", error=str(e), finished_at=datetime.now(UTC))
            return
        except Exception as e:  # noqa: BLE001 — no login (session-only, gone): its user resumes it
            await state.write(db, run_id, attempt, status="interrupted", error=str(getattr(e, "detail", e)), finished_at=datetime.now(UTC))
            raise
    await executor.run()


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
        outcome: dict = {}
        try:
            await self.note(self.start_note())
            await self.setup()
            await self.body()
            outcome = {"status": "done"}
        except asyncio.CancelledError:
            outcome = {"status": "cancelled" if await self.requested() == "cancel" else "paused"}
            raise
        except state.Fenced:
            outcome = {}
            raise
        except Exception as e:  # noqa: BLE001 — any failure is the run's, shown on its page
            logger.exception("server run %s failed", self.run_id)
            outcome = {"status": "failed", "error": str(e)[:4000]}
            raise
        finally:
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)
            with contextlib.suppress(Exception):
                await asyncio.shield(self.teardown())
            if outcome:
                with contextlib.suppress(Exception):
                    await asyncio.shield(self.note(_ENDED_AS.get(outcome["status"]) or f"Failed: {outcome.get('error')}"))
                self.state.pop("current", None)
                with contextlib.suppress(state.Fenced):
                    await asyncio.shield(self.save(finished_at=datetime.now(UTC), requested=None, **outcome))
                self.ended(outcome["status"])

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
        inputs = await data_source_service._materialize_inputs(db, source, login)
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
                    data_source_service._audit(self.source, "query", sql)
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
        tag = (f"job:{ex.handle.job_id}", str(ex.user_id))
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
    text = str(error).strip().splitlines()
    return (text[0] if text else type(error).__name__)[:300]


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
