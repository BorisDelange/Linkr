"""Query jobs: a list of read queries run on the server as one job.

A heavy computation the browser plans (a data catalog's counts) used to send its
queries one HTTP request each; a gateway in front of the API cuts any request
past its timeout (nginx: 60 s), while the query goes on unseen. As a job, the
queries run one after the other in the "heavy_query" lane — so two big DuckDB
queries never run together — and each result is written to a file the client
fetches once it is ready. The client only ever makes short requests, and the job
outlives the tab that started it.

Each query takes the same path as `POST /query` (`read_rows`): the caller's own
login, the row cap of `allRows`, and its own access-log line — or another runner
that keeps its result itself (`write_concept_units`). Cancelling the job
interrupts the query in flight, not only the task waiting on it. While one runs,
the job reports how much of its data it has read (`query_cancel.progress`).

Results live under `data_dir/job-results/<job id>/<key>.json`, the same body
`/query` answers. They go when the job is cleared from the panel, or after
`RESULTS_TTL_SECONDS` (swept at startup).
"""

import asyncio
import json
import re
import shutil
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import NamedTuple

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core import audit, database
from app.models.data_source import DataSource
from app.services import data_source_service
from app.services.data import db_connect, query_cancel
from app.services.database_credential_service import Login
from app.services.execution import jobs

RESULTS_TTL_SECONDS = 24 * 3600
# How often the query in flight is asked how far it has read.
PROGRESS_POLL_SECONDS = 1.0
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


def write_result(path: Path, rows: list[dict]) -> None:
    """Keep a query's rows as the body `/query` answers, atomically."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"rows": rows}, default=str))
    tmp.replace(path)


class JobQuery(NamedTuple):
    key: str
    sql: str
    # Overrides the job's own `pushdown` (a rule set mixes its own checks and
    # hand-written ones); None keeps it.
    pushdown: bool | None = None


# Runs one query of the job, in the job's own session: its rows, to be kept for
# the client, or None when it keeps its result itself.
Runner = Callable[[AsyncSession, DataSource, JobQuery], Awaitable[list[dict] | None]]


def read_rows(login: Login | None, pushdown: bool) -> Runner:
    """The default: the query's rows, as `POST /query` answers them."""

    async def run(db: AsyncSession, source: DataSource, q: JobQuery) -> list[dict]:
        push = pushdown if q.pushdown is None else q.pushdown
        return await data_source_service.query(db, source, login, q.sql, pushdown=push)

    return run


# A concept job's query whose key starts so writes the list from the units done
# so far, rather than count a unit.
ASSEMBLE_KEY_PREFIX = "assemble-"


def write_concept_units(login: Login | None, run_id: str) -> Runner:
    """Each query is a counting unit of run `run_id`, kept as its unit's file
    (data_source_service.write_concept_unit), or an assembly of the concept list
    from the units done so far: nothing for the client to fetch. Assembling in
    the job, between two units, keeps it from running beside a heavy one."""

    async def run(db: AsyncSession, source: DataSource, q: JobQuery) -> None:
        if q.key.startswith(ASSEMBLE_KEY_PREFIX):
            await data_source_service.assemble_concept_cache(db, source, login, q.sql)
        else:
            await data_source_service.write_concept_unit(db, source, login, q.key, q.sql, run_id)

    return run


async def start(
    db,
    source_id: str,
    workspace_id: str,
    user_id: int,
    label: str,
    queries: list[JobQuery],
    runner: Runner,
    keep_going: bool = False,
):
    """Create the job and launch it; returns the queued Job row.

    A failing query ends the job, unless `keep_going`: its error is then kept by
    its key and the next one runs (a rule set's checks, each judged alone)."""
    job = await jobs.create(db, None, user_id, kind="query", label=label, workspace_id=workspace_id)
    job_id = job.id
    # Tags the query in flight so a cancel can interrupt it (query_cancel).
    tag = (f"job:{job_id}", str(user_id))
    launched_by = audit.actor()

    async def body(handle: jobs.JobHandle) -> None:
        done: list[str] = []
        rows_by_key: dict[str, int] = {}
        ms_by_key: dict[str, int] = {}
        errors: dict[str, str] = {}

        def progress(**extra) -> dict:
            return {
                "sourceId": source_id, "done": done, "rows": rows_by_key, "ms": ms_by_key,
                "total": len(queries), **({"errors": errors} if errors else {}), **extra,
            }

        for i, q in enumerate(queries):
            key = q.key
            started = time.monotonic()

            async def reading(pct: float, i: int = i, key: str = key) -> None:
                await handle.set_result(progress(current=key, reading=int(pct)))
                await handle.progress(int(100 * (i + pct / 100) / len(queries)))

            run = asyncio.create_task(_run_one(job_id, source_id, runner, q, tag, launched_by))
            watch = asyncio.create_task(_watch_progress(tag, reading))
            rows = None
            try:
                rows = await run
            except Exception as e:
                # The log keeps it too, but a DuckDB error spans lines: the client
                # shows this one whole.
                if not keep_going:
                    await handle.set_result(progress(error=str(e)))
                    raise
                errors[key] = str(e)
            finally:
                # Waited for, so a late report cannot land over what follows.
                watch.cancel()
                await asyncio.gather(watch, return_exceptions=True)
            elapsed = time.monotonic() - started
            if rows is not None:
                await asyncio.to_thread(write_result, result_path(job_id, key), rows)
                rows_by_key[key] = len(rows)
            ms_by_key[key] = round(elapsed * 1000)
            done.append(key)
            await handle.set_result(progress())
            await handle.progress(int(100 * (i + 1) / len(queries)))
            outcome = "failed" if key in errors else "" if rows is None else f"{len(rows)} rows"
            await handle.log(f"{i + 1}/{len(queries)} {key}{': ' + outcome if outcome else ''} in {elapsed:.1f} s")

    jobs.launch(job_id, body, lane="heavy_query")
    return job


async def _watch_progress(tag: tuple[str, str], report) -> None:
    """Report how much of its data the query in flight has read, whenever that
    moves by a whole percent — until cancelled. A query DuckDB cannot follow
    (pushed down to an external database) reports nothing."""
    last = None
    while True:
        await asyncio.sleep(PROGRESS_POLL_SECONDS)
        pct = query_cancel.progress(*tag)
        if pct is not None and int(pct) != last:
            last = int(pct)
            await report(pct)


async def _run_one(job_id, source_id, runner, q, tag, launched_by) -> list[dict] | None:
    token = query_cancel.current_query.set(tag)
    cap = db_connect.row_cap.set(db_connect.MAX_QUERY_ROWS_ALL)
    try:
        # One access-log line per query, as through `/query`.
        with audit.job_scope(job_id, "query", launched_by):
            async with database.async_session() as db:
                source = await data_source_service.get(db, source_id)
                if source is None:
                    raise ValueError("the database no longer exists")
                return await runner(db, source, q)
    except asyncio.CancelledError:
        # The task stops here, but the query runs on in its thread: interrupt it.
        query_cancel.cancel(*tag)
        raise
    finally:
        query_cancel.current_query.reset(token)
        db_connect.row_cap.reset(cap)
