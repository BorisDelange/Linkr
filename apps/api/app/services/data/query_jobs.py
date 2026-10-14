"""Query jobs: a list of read queries run on the server as one job.

A heavy computation the browser plans (a data catalog's counts) used to send its
queries one HTTP request each; a gateway in front of the API cuts any request
past its timeout (nginx: 60 s), while the query goes on unseen. As a job, the
queries run one after the other in the "heavy_query" lane — so two big DuckDB
queries never run together — and each result is written to a file the client
fetches once it is ready. The client only ever makes short requests, and the job
outlives the tab that started it.

Each query takes the same path as `POST /query`: the caller's own login, the row
cap of `allRows`, and its own access-log line. Cancelling the job interrupts the
query in flight, not only the task waiting on it.

Results live under `data_dir/job-results/<job id>/<key>.json`, the same body
`/query` answers. They go when the job is cleared from the panel, or after
`RESULTS_TTL_SECONDS` (swept at startup).
"""

import asyncio
import json
import re
import shutil
import time
from pathlib import Path

from app.config import settings
from app.core import audit, database
from app.services import data_source_service
from app.services.data import db_connect, query_cancel
from app.services.database_credential_service import Login
from app.services.execution import jobs

RESULTS_TTL_SECONDS = 24 * 3600
# A key names a result file: kept to characters safe in a path.
KEY_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


def results_dir(job_id: str) -> Path:
    return settings.data_path / "job-results" / job_id


def result_path(job_id: str, key: str) -> Path | None:
    """The file holding `key`'s rows, or None when the key is not a valid one."""
    if not KEY_RE.match(key):
        return None
    return results_dir(job_id) / f"{key}.json"


def drop_results(job_id: str) -> None:
    shutil.rmtree(results_dir(job_id), ignore_errors=True)


def sweep_results(max_age_seconds: float = RESULTS_TTL_SECONDS) -> None:
    """Remove result folders older than `max_age_seconds`."""
    root = settings.data_path / "job-results"
    if not root.is_dir():
        return
    cutoff = time.time() - max_age_seconds
    for folder in root.iterdir():
        if folder.is_dir() and folder.stat().st_mtime < cutoff:
            shutil.rmtree(folder, ignore_errors=True)


def _write(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"rows": rows}, default=str))
    tmp.replace(path)


async def start(
    db,
    source_id: str,
    workspace_id: str,
    user_id: int,
    login: Login | None,
    label: str,
    queries: list[tuple[str, str]],
    pushdown: bool,
):
    """Create the job and launch it; returns the queued Job row."""
    job = await jobs.create(db, None, user_id, kind="query", label=label, workspace_id=workspace_id)
    job_id = job.id
    # Tags the query in flight so a cancel can interrupt it (query_cancel).
    tag = (f"job:{job_id}", str(user_id))
    launched_by = audit.actor()

    async def body(handle: jobs.JobHandle) -> None:
        done: list[str] = []
        rows_by_key: dict[str, int] = {}

        def progress(**extra) -> dict:
            return {"sourceId": source_id, "done": done, "rows": rows_by_key, "total": len(queries), **extra}

        for i, (key, sql) in enumerate(queries):
            started = time.monotonic()
            try:
                rows = await _run_one(job_id, source_id, login, sql, pushdown, tag, launched_by)
            except Exception as e:
                # The log keeps it too, but a DuckDB error spans lines: the client
                # shows this one whole.
                await handle.set_result(progress(error=str(e)))
                raise
            await asyncio.to_thread(_write, result_path(job_id, key), rows)
            done.append(key)
            rows_by_key[key] = len(rows)
            await handle.set_result(progress())
            await handle.progress(int(100 * (i + 1) / len(queries)))
            await handle.log(f"{i + 1}/{len(queries)} {key}: {len(rows)} rows in {time.monotonic() - started:.1f} s")

    jobs.launch(job_id, body, lane="heavy_query")
    return job


async def _run_one(job_id, source_id, login, sql, pushdown, tag, launched_by) -> list[dict]:
    token = query_cancel.current_query.set(tag)
    cap = db_connect.row_cap.set(db_connect.MAX_QUERY_ROWS_ALL)
    try:
        # One access-log line per query, as through `/query`.
        with audit.job_scope(job_id, "query", launched_by):
            async with database.async_session() as db:
                source = await data_source_service.get(db, source_id)
                if source is None:
                    raise ValueError("the database no longer exists")
                return await data_source_service.query(db, source, login, sql, pushdown=pushdown)
    except asyncio.CancelledError:
        # The task stops here, but the query runs on in its thread: interrupt it.
        query_cancel.cancel(*tag)
        raise
    finally:
        query_cancel.current_query.reset(token)
        db_connect.row_cap.reset(cap)
