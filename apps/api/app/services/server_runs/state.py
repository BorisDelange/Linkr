"""The rows of `server_runs` and the moves between their statuses.

Only the executor (`executor`) writes `status` once a run is claimed; the page asks
through `requested`. Every executor write names the attempt it claimed, so a
stale executor — one a restart or a takeover replaced — writes nothing.

One server process runs the runs: a run active under another boot is dead, as
`jobs.reconcile_on_startup` takes a job to be (Linkr runs one uvicorn worker).
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.server_run import ACTIVE_STATUSES, ServerRun

# Ended, but taken back where it stopped by a resume.
RESUMABLE = ("paused", "interrupted", "failed")

BOOT_ID = str(uuid.uuid4())

# Renewed at each batch and by a heartbeat in between. A queued run gets one
# too: claimed within it, or no executor is coming for it.
LEASE_SECONDS = 120

# Kept per kind and scope besides the active one: the page shows the
# last; the others are history for the panel.
KEPT_ENDED = 5


class Fenced(Exception):
    """This executor's attempt is no longer the run's: it must stop writing."""


def _lease() -> datetime:
    return datetime.now(UTC) + timedelta(seconds=LEASE_SECONDS)


async def active(db: AsyncSession, kind: str, scope_id: str) -> ServerRun | None:
    return (await db.execute(
        select(ServerRun).where(
            ServerRun.kind == kind, ServerRun.scope_id == scope_id, ServerRun.status.in_(ACTIVE_STATUSES),
        )
    )).scalar_one_or_none()


async def latest(db: AsyncSession, kind: str, scope_id: str) -> ServerRun | None:
    return (await db.execute(
        select(ServerRun).where(ServerRun.kind == kind, ServerRun.scope_id == scope_id)
        .order_by(ServerRun.created_at.desc(), ServerRun.id.desc()).limit(1)
    )).scalar_one_or_none()


async def create(
    db: AsyncSession, *, kind: str, scope_id: str, data_source_id: str | None, workspace_id: str | None,
    user_id: int, spec: dict, initial: dict,
) -> tuple[ServerRun, bool]:
    """A new queued run, or the one already going on for the same kind and scope
    — the unique index decides, not a check here, so two starts at once give one
    run. The second value says whether it is new. `initial`: its first state."""
    run = ServerRun(
        data_source_id=data_source_id, kind=kind, scope_id=scope_id, workspace_id=workspace_id,
        user_id=user_id, status="queued", spec=spec, attempt=0, boot_id=BOOT_ID, lease_until=_lease(),
        # To the microsecond: two runs of one second must still say which is the last.
        created_at=datetime.now(UTC),
        state=initial,
    )
    db.add(run)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existing = await active(db, kind, scope_id)
        if existing is None:
            raise
        return existing, False
    await db.refresh(run)
    return run, True


async def prune(db: AsyncSession, kind: str, scope_id: str) -> list[str]:
    """Drop the oldest ended runs; their ids, whose files must go too."""
    ended = (await db.execute(
        select(ServerRun.id).where(
            ServerRun.kind == kind, ServerRun.scope_id == scope_id, ServerRun.status.not_in(ACTIVE_STATUSES),
        ).order_by(ServerRun.created_at.desc(), ServerRun.id.desc()).offset(KEPT_ENDED)
    )).scalars().all()
    for run_id in ended:
        run = await db.get(ServerRun, run_id)
        if run is not None:
            await db.delete(run)
    await db.commit()
    return list(ended)


async def requeue(db: AsyncSession, run: ServerRun, **values) -> bool:
    """A paused, interrupted or failed run queued again where it stopped, as the
    user who started it; False when it was no longer resumable (resumed already,
    by a second click). IntegrityError when another run of its scope is going on.
    `values`: its new `state` and `spec`, for a resume bringing a spec."""
    result = await db.execute(
        update(ServerRun)
        .where(ServerRun.id == run.id, ServerRun.status.in_(RESUMABLE))
        .values(
            status="queued", requested=None, error=None, finished_at=None, boot_id=BOOT_ID, lease_until=_lease(),
            **values,
        )
    )
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise
    await db.refresh(run)
    return result.rowcount == 1


async def end(db: AsyncSession, run: ServerRun, status: str, *, among: tuple[str, ...], **values) -> bool:
    """Set an ended status on a run no executor writes — one still in `among`, as
    read at this moment, not as the caller last saw it. Whether it was."""
    result = await db.execute(
        update(ServerRun)
        .where(ServerRun.id == run.id, ServerRun.status.in_(among))
        .values(status=status, finished_at=datetime.now(UTC), **values)
    )
    await db.commit()
    await db.refresh(run)
    return result.rowcount == 1


async def claim(db: AsyncSession, run_id: str) -> int | None:
    """Take a queued run for this process: its attempt, or None when it is no
    longer queued (paused before its turn, or claimed already)."""
    row = await db.get(ServerRun, run_id)
    if row is None or row.status != "queued":
        return None
    attempt = row.attempt + 1
    result = await db.execute(
        update(ServerRun)
        .where(ServerRun.id == run_id, ServerRun.attempt == row.attempt, ServerRun.status == "queued")
        .values(attempt=attempt, status="running", boot_id=BOOT_ID, lease_until=_lease())
    )
    await db.commit()
    return attempt if result.rowcount == 1 else None


async def write(db: AsyncSession, run_id: str, attempt: int, **values) -> None:
    """Write as the executor of `attempt`, renewing its lease; Fenced when the run
    is another attempt's now."""
    result = await db.execute(
        update(ServerRun)
        .where(ServerRun.id == run_id, ServerRun.attempt == attempt)
        .values(lease_until=_lease(), **values)
    )
    await db.commit()
    if result.rowcount != 1:
        raise Fenced(run_id)


async def fence(db: AsyncSession, run_id: str, attempt: int, **values) -> None:
    """`write` without its commit: the caller's own writes then go in the same
    transaction, which it commits — or none of them when Fenced."""
    result = await db.execute(
        update(ServerRun)
        .where(ServerRun.id == run_id, ServerRun.attempt == attempt)
        .values(lease_until=_lease(), **values)
    )
    if result.rowcount != 1:
        await db.rollback()
        raise Fenced(run_id)


async def requested(db: AsyncSession, run_id: str) -> str | None:
    return (await db.execute(select(ServerRun.requested).where(ServerRun.id == run_id))).scalar_one_or_none()


async def ask(db: AsyncSession, run: ServerRun, action: str) -> ServerRun:
    """Record what the page asks ('pause', 'cancel'). A run not yet claimed stops
    here; a running one shows `pausing` until its executor has stopped. A run
    that ended meanwhile is left as it ended."""
    stopped = "cancelled" if action == "cancel" else "paused"
    await db.execute(
        update(ServerRun).where(ServerRun.id == run.id, ServerRun.status == "queued")
        .values(requested=action, status=stopped, finished_at=datetime.now(UTC))
    )
    await db.execute(
        update(ServerRun).where(ServerRun.id == run.id, ServerRun.status.in_(("running", "pausing")))
        .values(requested=action, status="pausing")
    )
    await db.commit()
    await db.refresh(run)
    return run


async def orphans(db: AsyncSession) -> list[ServerRun]:
    """The runs left active by an earlier server process."""
    return list((await db.execute(
        select(ServerRun).where(
            ServerRun.status.in_(ACTIVE_STATUSES),
            (ServerRun.boot_id.is_(None)) | (ServerRun.boot_id != BOOT_ID),
        )
    )).scalars().all())
