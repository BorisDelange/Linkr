"""An ETL pipeline run (`etl`): its scripts in order on the pipeline's managed
target, each one DuckDB session (`data_source_service.run_etl`), the checkpoint
written as each script ends — a script is the step: its statements share a
session (`SET VARIABLE`, temp tables), so a cut one runs again from its start.

The run owns its history row (`etl_run_history`, id = the run's), which the
Pipeline tab lists: `running` while it goes on or waits paused, then `success`
or `error`. A pause cuts the statement in flight (the run's handle interrupts
it, the target is let go) and marks its script `stopped`.

A server restart does not resume it by itself (`registry`): the cut script left
its first statements' writes, and running it again is its user's call.
"""

import asyncio
import logging
from datetime import UTC, datetime

from app.core import audit, database
from app.models.etl_pipeline import EtlRunHistory
from app.schemas.etl_run import EtlRunSpec
from app.services import (
    data_source_service,
    database_credential_service,
    etl_pipeline_service,
)
from app.services.data import db_connect
from app.services.server_runs.executor import (
    Gone,
    RunExecutor,
    launched_by,
    short,
    took,
)

logger = logging.getLogger(__name__)

# The statement text kept in the state, for the progress line.
_SQL_PREVIEW = 2000
# The state is written at most this often while a statement runs.
_REPORT_EVERY_S = 1.0


def _iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class EtlExecutor(RunExecutor):
    def __init__(self, run, attempt, spec, handle, launched_by, target, roles):
        super().__init__(run, attempt, spec, handle, launched_by)
        self.target = target
        self.roles = roles
        self.pipeline_id = spec.pipeline_id

    @classmethod
    async def create(cls, db, run, attempt, spec: EtlRunSpec, handle):
        target = await data_source_service.get(db, run.scope_id)
        if target is None:
            raise Gone("the target database no longer exists")
        roles = {}
        for role, ds_id in spec.roles.items():
            source = await data_source_service.get(db, ds_id)
            if source is None:
                raise Gone(f"the {role} database no longer exists")
            roles[role] = source
        # Checked now: a login that is not there leaves the run waiting for its user.
        for source in (target, *roles.values()):
            await database_credential_service.resolve_login(db, source, run.user_id)
        return cls(run, attempt, spec, handle, await launched_by(db, run.user_id), target, roles)

    # --- progress ---------------------------------------------------------------

    def percent(self) -> int:
        st = self.state
        total = len(self.spec.steps) or 1
        current = st.get("current") or {}
        within = (current.get("index", 0) / current["total"]) if current.get("total") else 0
        return int(100 * (st.get("next", 0) + within) / total)

    def start_note(self) -> str:
        n = self.state.get("next", 0)
        if self.attempt > 1 and n > 0:
            return f"Resumed at script {n + 1} of {len(self.spec.steps)}"
        return super().start_note()

    def _log(self, file_id: str, **values) -> dict:
        """The script's log in the state, as the page shows it (EtlRunLog)."""
        scripts: list[dict] = self.state.setdefault("scripts", [])
        log = next((s for s in scripts if s["fileId"] == file_id), None)
        if log is None:
            log = {"id": f"{self.run_id}-{file_id}", "pipelineId": self.pipeline_id, "fileId": file_id}
            scripts.append(log)
        for key in ("error", "output", "statementsDone", "statementsTotal", "currentStatement"):
            log.pop(key, None)
        log.update(values)
        return log

    async def _history(self, status: str, completed: bool = False) -> None:
        async with database.async_session() as db:
            row = await db.get(EtlRunHistory, self.run_id)
            created = row is None
            if row is None:
                row = EtlRunHistory(
                    id=self.run_id, pipeline_id=self.pipeline_id, started_at=self.state.get("startedAt") or _iso(),
                    created_by_id=self.user_id,
                )
                db.add(row)
            row.status = status
            row.completed_at = _iso() if completed else None
            row.scripts = [dict(s) for s in self.state.get("scripts", [])]
            await db.commit()
            if created:
                # The list keeps its last runs, as one written by the page does.
                await etl_pipeline_service._prune_runs(db, self.pipeline_id)

    # --- the run ----------------------------------------------------------------

    async def body(self) -> None:
        st = self.state
        st.setdefault("startedAt", _iso())
        st.setdefault("pipelineId", self.pipeline_id)
        st["fileIds"] = [step.file_id for step in self.spec.steps]
        await self._history("running")
        steps = self.spec.steps
        try:
            while st.get("next", 0) < len(steps):
                i = st.get("next", 0)
                await self.boundary()
                step = steps[i]
                if step.sql is None or not step.sql.strip():
                    self._log(step.file_id, status="skipped")
                else:
                    await self._script(step)
                st["next"] = i + 1
                st.pop("current", None)
                await self.save()
                await self._history("running")
        except asyncio.CancelledError:
            # Paused or cancelled: the script in flight did not end.
            for log in st.get("scripts", []):
                if log.get("status") == "running":
                    self._log(log["fileId"], status="stopped", startedAt=log.get("startedAt"),
                              completedAt=_iso(), durationMs=log.get("durationMs"))
            ending = "error" if await self.requested() == "cancel" else "running"
            await asyncio.shield(self._history(ending, completed=ending != "running"))
            raise
        except Exception:
            await asyncio.shield(self._history("error", completed=True))
            raise
        await self._history("success", completed=True)

    async def _script(self, step) -> None:
        st = self.state
        started_at = _iso()
        started = asyncio.get_running_loop().time()
        self._log(step.file_id, status="running", startedAt=started_at)
        st["current"] = {"fileId": step.file_id, "index": 0, "total": 0, "sql": ""}
        await self.handle.set_input(f"-- Script “{step.name}”\n{step.sql}")
        await self.save()
        await self._history("running")

        loop = asyncio.get_running_loop()
        run = db_connect.EtlRunHandle()
        changed = asyncio.Event()

        # From the DuckDB worker thread, before each statement.
        def on_statement(index: int, total: int, stmt: str) -> None:
            def note() -> None:
                st["current"] = {"fileId": step.file_id, "index": index, "total": total, "sql": stmt[:_SQL_PREVIEW]}
                self._log(step.file_id, status="running", startedAt=started_at,
                          statementsDone=index, statementsTotal=total, currentStatement=stmt[:_SQL_PREVIEW])
                changed.set()
            loop.call_soon_threadsafe(note)

        async def report() -> None:
            last_reading = None
            while True:
                try:
                    await asyncio.wait_for(changed.wait(), _REPORT_EVERY_S)
                except TimeoutError:
                    pass
                pct = run.progress()
                if pct is not None and int(pct) != last_reading:
                    last_reading = int(pct)
                    st.setdefault("current", {})["reading"] = last_reading
                    changed.set()
                if changed.is_set():
                    changed.clear()
                    await self.save()

        reporter = asyncio.create_task(report())
        try:
            try:
                with audit.job_scope(self.handle.job_id, "etl", self.launched_by):
                    async with database.async_session() as session:
                        rows = await data_source_service.run_etl(
                            session, self.target, step.sql, self.roles, self.user_id, self.spec.mapping_data,
                            on_statement=on_statement, handle=run,
                        )
            finally:
                reporter.cancel()
                await asyncio.gather(reporter, return_exceptions=True)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            ms = int((asyncio.get_running_loop().time() - started) * 1000)
            self._log(step.file_id, status="error", startedAt=started_at, completedAt=_iso(), durationMs=ms, error=str(e))
            await self.note(f"Script “{step.name}” failed: {short(e)}")
            raise
        ms = int((asyncio.get_running_loop().time() - started) * 1000)
        self._log(
            step.file_id, status="success", startedAt=started_at, completedAt=_iso(), durationMs=ms,
            rowsAffected=len(rows), output=f"{len(rows)} row{'s' if len(rows) != 1 else ''} in {took(started)}",
        )
        await self.note(f"Script “{step.name}”: {took(started)}")
