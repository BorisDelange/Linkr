"""ETL runs as jobs: one script on its target, run by the server as a job.

Streamed over a WebSocket, a run sent nothing while a statement ran, so a
statement longer than a gateway's idle timeout had the socket cut — and the cut
cancelled the run. As a job, the run belongs to the server: the client polls the
job (short requests only), closing the tab does not stop it, and the jobs panel
does. It runs in the "heavy_query" lane, never beside another heavy query.

The job reports the statement it is on (`index`, `total`, `sql`) and, while one
runs, how much of its data it has read (`reading`, DuckDB's progress). The rows of
the last statement go to `job-results/<job>/rows.json`, fetched like a query
job's (`query_jobs.result_path`).
"""

import asyncio

from app.core import audit
from app.models.data_source import DataSource
from app.services import data_source_service
from app.services.data import db_connect, query_jobs
from app.services.execution import jobs

ROWS_KEY = "rows"
# The statement text kept on the job row, for the progress line.
_SQL_PREVIEW = 2000


async def start(
    db,
    target: DataSource,
    roles: dict[str, DataSource],
    user_id: int,
    label: str,
    sql: str,
    mapping_data: dict[str, str],
):
    """Create the job and launch it; returns the queued Job row."""
    job = await jobs.create(db, None, user_id, kind="etl", label=label, workspace_id=target.workspace_id)
    job_id = job.id
    launched_by = audit.actor()

    async def body(handle: jobs.JobHandle) -> None:
        loop = asyncio.get_running_loop()
        run = db_connect.EtlRunHandle()
        state: dict = {"sourceId": target.id, "index": 0, "total": 0, "sql": ""}
        changed = asyncio.Event()

        # From the DuckDB worker thread, before each statement.
        def on_statement(index: int, total: int, stmt: str) -> None:
            def note() -> None:
                state.update(index=index, total=total, sql=stmt[:_SQL_PREVIEW])
                state.pop("reading", None)
                changed.set()
            loop.call_soon_threadsafe(note)

        async def report() -> None:
            last_reading = None
            while True:
                try:
                    await asyncio.wait_for(changed.wait(), query_jobs.PROGRESS_POLL_SECONDS)
                except TimeoutError:
                    pass
                pct = run.progress()
                if changed.is_set() or (pct is not None and int(pct) != last_reading):
                    changed.clear()
                    if pct is not None:
                        last_reading = int(pct)
                        state["reading"] = last_reading
                    total = state["total"] or 1
                    await handle.set_result(dict(state))
                    await handle.progress(int(100 * (state["index"] + (state.get("reading") or 0) / 100) / total))

        reporter = asyncio.create_task(report())
        try:
            try:
                with audit.job_scope(job_id, "etl", launched_by):
                    async with jobs.async_session() as session:
                        rows = await data_source_service.run_etl(
                            session, target, sql, roles, user_id, mapping_data, on_statement=on_statement, handle=run,
                        )
            finally:
                # Stopped and waited for before the run's last word is written: a
                # report still in flight would land over it (an error lost).
                reporter.cancel()
                await asyncio.gather(reporter, return_exceptions=True)
        except Exception as e:
            await handle.set_result({**state, "error": str(e)})
            raise
        await asyncio.to_thread(query_jobs.write_result, query_jobs.result_path(job_id, ROWS_KEY), rows)
        await handle.set_result({**state, "reading": None, "done": [ROWS_KEY], "rows": {ROWS_KEY: len(rows)}})
        await handle.progress(100)

    jobs.launch(job_id, body, lane="heavy_query")
    return job
