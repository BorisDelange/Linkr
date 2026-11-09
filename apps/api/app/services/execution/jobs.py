"""Tracked long-running jobs with a bounded in-process executor (step 4).

A job is a DB row (``Job``) plus a live asyncio task. Tasks run behind a
semaphore so a burst can't exhaust the single uvicorn worker; excess jobs sit
``queued`` until a slot frees. No external broker (celery/RQ) — the DB-backed
model means a real queue can replace this runner later without a schema change.

Cancellation cancels the asyncio task; a well-behaved job body (see the uv build,
which runs `uv sync` as a subprocess) turns that CancelledError into killing its
child process. On server restart, jobs left ``running`` (their task is gone) are
reconciled to ``error`` at startup — the row survives, the process does not.
"""

import asyncio
import contextlib
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, delete, func, null, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core import audit, deferred
from app.core.database import async_session
from app.core.redact import redact_secrets, scrub_row_values
from app.models.job import Job
from app.models.project import Project
from app.models.user import User

# Live tasks by job id, so cancel() can reach a running job's asyncio.Task.
_tasks: dict[str, asyncio.Task] = {}
# One queue per lane: a long data catalog must not hold up an env build, nor the
# reverse. "build" also takes script runs and derivations.
_LANE_CAPS = {"build": "max_build_concurrency", "heavy_query": "max_heavy_queries"}
_semaphores: dict[str, asyncio.Semaphore] = {}
# Status writes of adopted tasks still in flight (see adopt).
_status_writes: set[asyncio.Task] = set()


def _sem(lane: str) -> asyncio.Semaphore:
    # Built lazily on first use so it binds to the running loop, and reads the
    # configured cap at that point.
    if lane not in _semaphores:
        _semaphores[lane] = asyncio.Semaphore(getattr(settings, _LANE_CAPS[lane]))
    return _semaphores[lane]


# A concept count's job carries thousands of unit queries: the panel shows the
# beginning, which is what tells one run from another.
INPUT_MAX = 200_000


def capped_input(text: str | None) -> str | None:
    if not text:
        return None
    return text if len(text) <= INPUT_MAX else text[:INPUT_MAX] + f"\n\n… ({len(text) - INPUT_MAX:,} more characters)"


# A query sent to a database (POST /data-sources/{id}/query, and every other
# route that reads or writes one): a job like the others, from the start, kept
# `query_log_hours` once finished (`purge_old_queries`).
QUERY_KIND = "sql_query"
# A list of queries whose rows wait in files for the client (query_jobs): same
# retention, counted from its end, since it may have run for hours.
QUERY_RESULTS_KIND = "query"
# Keep their row and lose their output past `job_output_hours`.
OUTPUT_KINDS = ("run", "etl", "derive")


@dataclass(frozen=True)
class Entity:
    """What a job is for, as the panel names it: `database`, `project`,
    `vocabulary`… with its id and name."""

    type: str
    id: str
    name: str


# The entity the request works on, set where the route loads it
# (`data_sources._load_source`): every job the request creates — each of its
# queries, a job started by it — is that entity's. Tasks started from the
# request carry it with them.
current_entity: ContextVar[Entity | None] = ContextVar("job_entity", default=None)


async def _entity_of(db: AsyncSession, entity: Entity | None, project_uid: str | None) -> Entity | None:
    entity = entity or current_entity.get()
    if entity is None and project_uid is not None:
        project = await db.get(Project, project_uid)
        if project is not None:
            entity = Entity("project", project_uid, _name_of(project.name) or project_uid)
    return entity


def _name_of(name: object) -> str:
    """A localized name in one language: English first, then any."""
    if isinstance(name, dict):
        return str(name.get("en") or next((v for v in name.values() if v), "") or "")
    return str(name or "")


async def create(
    db: AsyncSession,
    project_uid: str | None,
    user_id: int,
    kind: str,
    label: str,
    *,
    workspace_id: str | None = None,
    input: str | None = None,
    running: bool = False,
    group_key: str | None = None,
    group_label: str | None = None,
    entity: Entity | None = None,
) -> Job:
    """A queued job owned by a project, or — `project_uid` None — by a workspace.
    `input`: what it runs (its SQL, its code), kept for the panel. `running`: it
    starts at once, so it is created running rather than written twice.
    `group_key`: the action it is one of, shown with the others under one row
    named `group_label`."""
    if (project_uid is None) == (workspace_id is None):
        raise ValueError("a job belongs to exactly one project or one workspace")
    entity = await _entity_of(db, entity, project_uid)
    job = Job(
        project_uid=project_uid,
        workspace_id=workspace_id,
        user_id=user_id,
        kind=kind,
        label=label,
        status="running" if running else "queued",
        started_at=datetime.now(UTC) if running else None,
        input=capped_input(input),
        group_key=group_key or None,
        group_label=(group_label or None) if group_key else None,
        entity_type=entity.type if entity else None,
        entity_id=entity.id[:64] if entity else None,
        entity_name=entity.name[:255] if entity else None,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return job


async def purge_old_queries() -> int:
    """Apply the retention of what finished jobs hold, whoever sent them
    (storage_gc's loop, and at startup): the queries and their result files go past
    `settings.query_log_hours`, the output of the other row-bearing jobs past
    `settings.job_output_hours`; one still running stays. Returns how many went."""
    from app.services.data import query_jobs

    now = datetime.now(UTC)
    cutoff = now - timedelta(hours=settings.query_log_hours)
    ended_at = func.coalesce(Job.finished_at, Job.created_at)
    async with async_session() as db:
        ids = list((await db.execute(
            select(Job.id).where(
                Job.status.in_(_ENDED),
                or_(
                    and_(Job.kind == QUERY_KIND, Job.created_at < cutoff),
                    and_(Job.kind == QUERY_RESULTS_KIND, ended_at < cutoff),
                ),
            )
        )).scalars().all())
        for i in range(0, len(ids), _PURGE_BATCH):
            await db.execute(delete(Job).where(Job.id.in_(ids[i:i + _PURGE_BATCH])))
        await db.execute(
            update(Job)
            .where(
                Job.kind.in_(OUTPUT_KINDS), Job.status.in_(_ENDED),
                ended_at < now - timedelta(hours=settings.job_output_hours),
                or_(Job.log_tail != "", Job.result.isnot(None)),
            )
            .values(log_tail="", result=null())
        )
        await db.commit()
    for job_id in ids:
        query_jobs.drop_results(job_id)
    query_jobs.sweep_results()
    return len(ids)


_PURGE_BATCH = 500


def launch(job_id: str, body, *, lane: str | None = "build", running: bool = True) -> None:
    """Schedule a job body (an async callable receiving a JobHandle). Runs behind
    its lane's semaphore — none: the body takes `lane_slot` itself, for each
    step; records status/log/progress transitions in its own DB session.
    `running=False`: the job stays queued until the body calls `mark_running`
    (with no lane, once its first step has a slot)."""
    _tasks[job_id] = asyncio.create_task(_run(job_id, body, audit.actor(), lane, running))


def lane_slot(lane: str) -> asyncio.Semaphore:
    """The lane's semaphore, for work run outside a job body that must still wait
    its turn (a deferred request, core/deferred)."""
    return _sem(lane)


async def adopt(job_id: str, task: asyncio.Task, *, running: bool = True, written: bool = False) -> None:
    """Make an already started task a job: cancellable from the panel, its status
    following the task's end. For work that became long only once started (a
    deferred request, core/deferred). Not `running` yet (it waits in its lane):
    queued, until `mark_running`."""
    # Written before the end can be: the two must not race. `written`: the job
    # was created in that state already.
    if not written:
        await _set(job_id, status="running" if running else "queued")
    _tasks[job_id] = task

    def finished(t: asyncio.Task) -> None:
        _tasks.pop(job_id, None)
        if t.cancelled() or isinstance(t.exception(), deferred.Stopped):
            fields = {"status": "cancelled"}
        elif t.exception() is not None:
            fields = {"status": "error", "log_tail": scrub_row_values(str(t.exception()))[-4000:]}
        else:
            fields = {"status": "done", "progress": 100}
        # Held until written: the loop keeps only a weak reference to a task.
        write = asyncio.get_running_loop().create_task(_set(job_id, **fields))
        _status_writes.add(write)
        write.add_done_callback(_status_writes.discard)

    if task.done():
        finished(task)
    else:
        task.add_done_callback(finished)


@asynccontextmanager
async def tracked(
    user_id: int, label: str, *, project_uid: str | None = None, workspace_id: str | None = None,
    input: str | None = None, kind: str = QUERY_KIND,
):
    """A job around a request's own work on a database (an introspection, a
    connection test), from its start to its end: short, so not stoppable, but
    seen. Nothing without an owner to show it under."""
    if project_uid is None and workspace_id is None:
        yield None
        return
    async with async_session() as db:
        job = await create(db, project_uid, user_id, kind, label, workspace_id=workspace_id, input=input, running=True)
    try:
        yield job.id
    except asyncio.CancelledError:
        await _set(job.id, status="cancelled")
        raise
    except Exception as e:
        await _set(job.id, status="error", log_tail=scrub_row_values(str(e))[-4000:])
        raise
    await _set(job.id, status="done", progress=100)


# A read past this many seconds becomes a job of the panel (`tracked_if_slow`).
SLOW_SECONDS = 2.0


class LateJob:
    """A `tracked_if_slow` request's job, once it has one, and what it says."""

    def __init__(self) -> None:
        self.job_id: str | None = None
        self.summary: str | None = None

    def note(self, text: str) -> None:
        self.summary = text


@asynccontextmanager
async def tracked_if_slow(
    user_id: int, label: str, *, project_uid: str | None = None, workspace_id: str | None = None,
    after: float | None = None,
):
    """As `tracked`, for a read that is nearly always instant (a database's
    tables, asked by every view that opens it): a job only once it has run
    `after` seconds — the panel shows one that hangs, not each of the dozens
    that answered at once."""
    late = LateJob()
    if project_uid is None and workspace_id is None:
        yield late
        return
    past = asyncio.Event()

    async def record() -> None:
        await asyncio.sleep(SLOW_SECONDS if after is None else after)
        past.set()
        async with async_session() as db:
            job = await create(db, project_uid, user_id, QUERY_KIND, label, workspace_id=workspace_id, running=True)
        late.job_id = job.id

    timer = asyncio.create_task(record())

    async def settle() -> str | None:
        # Past its sleep, the job is being written: waited for, not cut off.
        if past.is_set():
            await asyncio.gather(timer, return_exceptions=True)
        else:
            timer.cancel()
            await asyncio.gather(timer, return_exceptions=True)
        return late.job_id

    try:
        yield late
    except asyncio.CancelledError:
        if job_id := await settle():
            await _set(job_id, status="cancelled")
        raise
    except Exception as e:
        if job_id := await settle():
            await _set(job_id, status="error", log_tail=scrub_row_values(str(e))[-4000:])
        raise
    if job_id := await settle():
        await _set(job_id, status="done", progress=100, **({"log_tail": late.summary} if late.summary else {}))


async def note(job_id: str, text: str) -> None:
    """A job's one-line outcome, as its output."""
    await _set(job_id, log_tail=redact_secrets(text)[-4000:])


async def record_query(job_id: str, *, rows: int, sent: str | None, computed_by: str | None, reason: str | None) -> None:
    """What a query job answered: its row count (never the rows: they are patient
    data), who computed it, and the SQL the database itself was sent."""
    lines = [f"{rows:,} row{'s' if rows != 1 else ''}"]
    if computed_by == "database":
        lines.append("Computed by the database.")
    elif computed_by == "linkr":
        lines.append("Computed by Linkr (DuckDB)" + (f": {reason}" if reason else "."))
    fields: dict = {"log_tail": "\n".join(lines)}
    if sent:
        async with async_session() as db:
            current = (await db.execute(select(Job.input).where(Job.id == job_id))).scalar_one_or_none()
        fields["input"] = capped_input(f"{current or ''}\n\n-- Sent to the database\n{sent}")
    await _set(job_id, **fields)


async def mark_running(job_id: str) -> None:
    """An adopted job that waited in its lane got its slot."""
    await _set(job_id, status="running")


async def run_now(job_id: str, body) -> None:
    """Run a job body and AWAIT it (still tracked + visible + cancellable via the
    same task registry). Used for auto-build on first run, where the triggering
    request must block until the env is ready."""
    task = asyncio.create_task(_run(job_id, body, audit.actor()))
    _tasks[job_id] = task
    await task


async def _run(job_id: str, body, launched_by: dict, lane: str | None = "build", running: bool = True) -> None:
    """`launched_by` is the launching request's actor: the job's own access-log
    line (core/audit) names them, whatever data the body touches."""
    handle = JobHandle(job_id)
    try:
        async with _sem(lane) if lane else contextlib.nullcontext():
            if running:
                await _set(job_id, status="running")
            with audit.job_scope(job_id, "job", launched_by):
                await body(handle)
            await _set(job_id, status="done", progress=100)
    except asyncio.CancelledError:
        await _set(job_id, status="cancelled")
        raise
    except Exception as e:  # a job body failure is the job's error, not a 500
        await handle.log(scrub_row_values(str(e)))
        await _set(job_id, status="error")
    finally:
        _tasks.pop(job_id, None)


class JobHandle:
    """Passed to a job body so it can append to the log and report progress
    without owning a DB session."""

    def __init__(self, job_id: str):
        self.job_id = job_id

    async def log(self, line: str) -> None:
        # A driver's error quotes the DSN it was given, password included.
        line = redact_secrets(line)
        async with async_session() as db:
            job = await db.get(Job, self.job_id)
            if job is None:
                return
            # Append the line; don't prefix a newline when the log is still empty,
            # and strip leading blank lines off the first entry — otherwise the
            # panel opens on an empty leading line.
            combined = f"{job.log_tail}\n{line}" if job.log_tail else line.lstrip("\n")
            # Keep only the tail so a chatty build doesn't bloat the row.
            job.log_tail = "\n".join(combined.splitlines()[-200:])
            await db.commit()

    async def progress(self, pct: int) -> None:
        await _set(self.job_id, progress=max(0, min(100, pct)))

    async def set_input(self, text: str) -> None:
        """What the job runs now, for a job going through many queries."""
        await _set(self.job_id, input=capped_input(text))

    async def set_result(self, result: dict) -> None:
        """`error`/`errors` carry a driver's text, kept to what a log may hold."""
        if isinstance(result.get("error"), str):
            result = {**result, "error": scrub_row_values(result["error"])}
        if isinstance(result.get("errors"), dict):
            result = {
                **result,
                "errors": {k: scrub_row_values(v) if isinstance(v, str) else v for k, v in result["errors"].items()},
            }
        await _set(self.job_id, result=result)


@asynccontextmanager
async def live_log(handle: JobHandle, every: float = 2.0):
    """An `on_log(line)` for a job body whose lines reach the job's log while it
    runs, every `every` seconds — a build that takes minutes shows where it is,
    instead of an empty log until it ends. The rest is written on exit, failure
    and cancellation included."""
    pending: list[str] = []
    done = asyncio.Event()

    async def flush() -> None:
        n = len(pending)
        if n:
            await handle.log("\n".join(pending[:n]))
            del pending[:n]

    async def tick() -> None:
        while not done.is_set():
            try:
                await asyncio.wait_for(done.wait(), every)
            except TimeoutError:
                pass
            await flush()

    task = asyncio.create_task(tick())
    try:
        yield pending.append
    finally:
        done.set()
        await task


_ENDED = ("done", "error", "cancelled")
_ACTIVE = ("queued", "running")


async def _set(job_id: str, **fields) -> None:
    status = fields.get("status")
    if status == "running":
        fields["started_at"] = func.now()
    elif status in _ENDED:
        fields["finished_at"] = func.now()
    async with async_session() as db:
        await db.execute(update(Job).where(Job.id == job_id).values(**fields))
        await db.commit()


def summary_of(log_tail: str | None) -> str | None:
    """A log's first line, as the panel's row shows it."""
    first = next((line for line in (log_tail or "").splitlines() if line.strip()), None)
    return first[:200] if first else None


def is_running(job_id: str) -> bool:
    """Whether the job's task is live in this process (queued behind the semaphore
    or running)."""
    task = _tasks.get(job_id)
    return task is not None and not task.done()


async def cancel(db: AsyncSession, job: Job) -> bool:
    """Cancel a live job. Returns False if it already finished (nothing to do)."""
    if not is_running(job.id):
        return False
    task = _tasks[job.id]
    _stopping.add(job.id)
    task.add_done_callback(lambda _: _stopping.discard(job.id))
    task.cancel()
    return True


# Jobs cancelled and still running: their query in flight takes its time to stop.
_stopping: set[str] = set()


def is_stopping(job_id: str) -> bool:
    return job_id in _stopping and is_running(job_id)


# What the panel lists: its last rows, a group counting as one; and the most
# jobs sent in all, the panel being polled every few seconds (past it, the
# oldest groups show only their latest jobs).
RECENT_JOBS = 100
LISTED_JOBS = 1000


def _owned_by(project_uid: str | None, workspace_id: str | None):
    return Job.project_uid == project_uid if project_uid is not None else Job.workspace_id == workspace_id


async def list_active(
    db: AsyncSession, project_uid: str | None, user_id: int, *, workspace_id: str | None = None
) -> list[Job]:
    """A user's non-terminal jobs for a project — or a workspace — (queued/running)
    plus recently finished ones, newest first — feeds the StatusBar panel: the
    jobs of its last `RECENT_JOBS` rows, a group counting as one."""
    entry = func.coalesce(Job.group_key, Job.id)
    owned = (_owned_by(project_uid, workspace_id), Job.user_id == user_id)
    recent = (
        select(entry.label("entry"))
        .where(*owned)
        .group_by(entry)
        .order_by(func.max(Job.created_at).desc())
        .limit(RECENT_JOBS)
    ).subquery()
    listed = (await db.execute(
        select(Job)
        .where(*owned)
        .where(entry.in_(select(recent.c.entry)))
        .order_by(Job.created_at.desc())
        .limit(LISTED_JOBS)
    )).scalars().all()
    # A job still running is always listed, however many rows came after it —
    # with its group, a group counting as one row: it can only be stopped from here.
    active = select(entry).where(*owned).where(Job.status.in_(_ACTIVE)).distinct()
    seen = {j.id for j in listed}
    older = [
        j for j in (await db.execute(select(Job).where(*owned).where(entry.in_(active)))).scalars().all()
        if j.id not in seen
    ]
    if not older:
        return list(listed)
    return sorted([*listed, *older], key=lambda j: j.created_at, reverse=True)


async def list_running_everywhere(db: AsyncSession) -> list[tuple[Job, str]]:
    """Every queued or running job of the instance with its user's name, newest
    first, at most `LISTED_JOBS`."""
    rows = await db.execute(
        select(Job, User.username)
        .join(User, User.id == Job.user_id)
        .where(Job.status.in_(_ACTIVE))
        .order_by(Job.created_at.desc())
        .limit(LISTED_JOBS)
    )
    return [(job, username) for job, username in rows.all()]


async def clear_finished(
    db: AsyncSession, project_uid: str | None, user_id: int, *, workspace_id: str | None = None
) -> None:
    """Remove the user's terminal jobs (done/error/cancelled) for a project or a
    workspace — the 'clear all' action. Active jobs (queued/running) are kept so
    a build in flight isn't lost from the panel."""
    from app.services.data import query_jobs

    finished = (
        select(Job.id)
        .where(_owned_by(project_uid, workspace_id))
        .where(Job.user_id == user_id)
        .where(Job.status.in_(("done", "error", "cancelled")))
    )
    ids = list((await db.execute(finished)).scalars().all())
    await db.execute(delete(Job).where(Job.id.in_(ids)))
    await db.commit()
    for job_id in ids:
        query_jobs.drop_results(job_id)


async def reconcile_on_startup() -> None:
    """A job left running/queued when the process died has no task anymore → mark
    it error so the panel doesn't show a phantom 'running' forever. Then drop
    the queries past their retention."""
    async with async_session() as db:
        await db.execute(
            update(Job)
            .where(Job.status.in_(("running", "queued")))
            .values(status="error", log_tail="Interrupted by server restart", finished_at=func.now())
        )
        await db.commit()
    await purge_old_queries()
