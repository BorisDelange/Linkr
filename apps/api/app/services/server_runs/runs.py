"""What the routes and the startup ask of server runs: start one, pause it,
resume it, and take back those a server restart cut."""

import asyncio
import logging
from datetime import UTC, datetime

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import database
from app.core.redact import scrub_row_values
from app.models.server_run import ACTIVE_STATUSES, ServerRun
from app.services.server_runs import executor, registry, state
from app.services.server_runs.state import RESUMABLE

logger = logging.getLogger(__name__)

LOST = "the server lost this run's executor; resume it to go on"


def _label(run: ServerRun) -> str:
    return str((run.spec or {}).get("label") or run.kind)


def _aware(moment: datetime) -> datetime:
    # SQLite gives back naive datetimes.
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


async def settled(db: AsyncSession, run: ServerRun | None) -> ServerRun | None:
    """`run` as it stands. One active under this process that nothing here will
    ever end — its task gone (its last write cut), or queued past its lease
    with no executor claiming it — ends now: as its page asked, else
    interrupted, for its user to resume."""
    if run is None or run.status not in ACTIVE_STATUSES or run.boot_id != state.BOOT_ID:
        return run
    if run.status == "queued":
        dead = run.lease_until is None or _aware(run.lease_until) < datetime.now(UTC)
    else:
        dead = not executor.is_running(run.id)
    if dead:
        await _end_unattended(db, run, "interrupted", error=LOST)
    return run


async def _end_unattended(db: AsyncSession, run: ServerRun, otherwise: str, **values) -> None:
    """End an active run no executor holds: as its page asked, else `otherwise`."""
    among = (run.status,)
    if run.requested == "cancel":
        await _close(db, run, among)
    elif run.requested == "pause":
        await state.end(db, run, "paused", among=among, requested=None)
    else:
        await state.end(db, run, otherwise, among=among, requested=None, **values)


async def _close(db: AsyncSession, run: ServerRun, among: tuple[str, ...]) -> None:
    """Cancel a run no executor holds: its files go, and its kind closes what the
    run left open for a resume (`Kind.on_closed`)."""
    if await state.end(db, run, "cancelled", among=among, requested=None):
        await _closed(run.id, run.kind)


async def _closed(run_id: str, kind_name: str) -> None:
    await executor.forget_files(run_id)
    kind = registry.KINDS.get(kind_name)
    if kind is not None and kind.on_closed is not None:
        try:
            await kind.on_closed(run_id)
        except Exception:  # noqa: BLE001 — the run is cancelled whatever its kind leaves
            logger.exception("server run %s: closing it failed", run_id)


async def _launch(db: AsyncSession, run: ServerRun) -> None:
    """Its executor's job; when none can be made, the run queued fails at once
    rather than wait for an executor that is not coming."""
    try:
        await executor.launch(run, _label(run))
    except Exception as e:
        await state.end(db, run, "failed", among=("queued",), error=scrub_row_values(str(e))[:4000])
        raise


async def start(
    db: AsyncSession, *, kind: str, scope_id: str, data_source_id: str | None, workspace_id: str | None,
    user_id: int, spec: dict, granted: dict | None = None,
) -> ServerRun:
    """The run going on for this kind and scope, or a new one: a second start — a
    second tab, a click during a reload — follows the first rather than run
    beside it. A paused one the new run replaces is closed. `spec` is validated.
    `granted`: what the server decided its starter may do, kept in its state."""
    model = registry.KINDS[kind].spec.model_validate(spec)
    await settled(db, await state.active(db, kind, scope_id))
    previous = await state.latest(db, kind, scope_id)
    run, created = await state.create(
        db, kind=kind, scope_id=scope_id, data_source_id=data_source_id, workspace_id=workspace_id,
        user_id=user_id, spec=model.model_dump(), initial={**registry.KINDS[kind].initial(model), **(granted or {})},
    )
    if not created:
        return run
    for pruned in await state.prune(db, kind, scope_id):
        await executor.forget_files(pruned)
    if previous is not None and previous.status in RESUMABLE:
        await _close(db, previous, RESUMABLE)
    await _launch(db, run)
    return run


async def pause(db: AsyncSession, run: ServerRun, action: str = "pause") -> ServerRun:
    """Ask for the stop: a running run stops at once — its step in flight cut,
    and done again on resume. A cancel also closes a run that waits to be
    resumed (paused, interrupted, failed)."""
    if action == "cancel" and run.status in RESUMABLE:
        await _close(db, run, RESUMABLE)
        return run
    run = await state.ask(db, run, action)
    if run.status == "cancelled":
        # Stopped before its executor claimed it.
        await _closed(run.id, run.kind)
    elif run.status == "pausing" and not executor.stop(run.id):
        # No executor here (its task ended without writing its outcome): nothing will act on it.
        await _end_unattended(db, run, "paused")
    return run


async def resume(db: AsyncSession, run: ServerRun, spec: dict | None = None, granted: dict | None = None) -> ServerRun:
    """Queue a paused, interrupted or failed run again where it stopped, as the
    user who started it. `spec`: compiled again by the page, for a kind that
    takes one (`Kind.respec`) — the steps done stay done. `granted`: as `start`'s,
    decided again now."""
    run = await settled(db, run)
    assert run is not None
    if run.status in ACTIVE_STATUSES:
        return run
    if run.status not in RESUMABLE:
        raise ValueError(f"a {run.status} run cannot be resumed")
    values: dict = {}
    run_state = dict(run.state or {})
    if spec is not None:
        kind = registry.KINDS[run.kind]
        if kind.respec is None:
            raise ValueError(f"a {run.kind} run resumes with the spec it started with")
        model = kind.spec.model_validate(spec)
        values = {"state": kind.respec(run_state, model), "spec": model.model_dump()}
    if granted:
        values["state"] = {**values.get("state", run_state), **granted}
    if not await state.requeue(db, run, **values):
        # Resumed already (a second click): the first resume launched it.
        return run
    await _launch(db, run)
    return run


async def recover_on_startup() -> None:
    """Runs an earlier process left going on: one its page asked to stop ends as
    asked; the others are interrupted, then resumed — they pick up at their
    last checkpoint. One that cannot read its database without its user (a
    session-only login) stays interrupted until they resume it."""
    async with database.async_session() as db:
        orphans = await state.orphans(db)
        for run in orphans:
            await _end_unattended(db, run, "interrupted")
        for run in orphans:
            kind = registry.KINDS.get(run.kind)
            if run.status != "interrupted" or kind is None or not kind.resume_on_startup:
                continue
            try:
                await resume(db, run)
            except Exception:  # noqa: BLE001 — one run that cannot resume must not stop the others
                logger.exception("server run %s could not resume", run.id)
        await sweep_files(db)


async def sweep_files(db: AsyncSession) -> None:
    """Drop the run folders no run row holds any more (one deleted with what it
    ran on by a cascade, or while its executor still wrote)."""
    root = executor.runs_root()

    def folders() -> list[str]:
        return [p.name for p in root.iterdir() if p.is_dir()] if root.is_dir() else []

    names = await asyncio.to_thread(folders)
    if not names:
        return
    known = set((await db.execute(select(ServerRun.id))).scalars().all())
    for name in names:
        if name not in known:
            await executor.forget_files(name)


# --- forgetting the runs of what is deleted -----------------------------------


async def forget(db: AsyncSession, kinds: tuple[str, ...], scope_ids: list[str]) -> None:
    """Drop the runs of these scopes, and their files — what they read goes (a
    cohort's member ids): a run going on is stopped first."""
    if not scope_ids:
        return
    await _forget(db, ServerRun.kind.in_(kinds), ServerRun.scope_id.in_(scope_ids))


async def forget_database(db: AsyncSession, source_id: str) -> None:
    """The runs reading a database, or of it (its statistics, its counts, a
    pipeline run into it): before it is deleted, its rows cascading away."""
    await _forget(db, or_(
        ServerRun.data_source_id == source_id,
        ServerRun.scope_id.in_((source_id, f"{source_id}:stats", f"{source_id}:counts")),
    ))


async def forget_workspace(db: AsyncSession, workspace_id: str) -> None:
    await _forget(db, ServerRun.workspace_id == workspace_id)


async def forget_pipeline(db: AsyncSession, pipeline_id: str, target_id: str | None) -> None:
    """Its Quality checks' runs, and a run of its scripts on its target."""
    await forget(db, ("etl_quality",), [pipeline_id])
    if target_id:
        rows = (await db.execute(
            select(ServerRun).where(ServerRun.kind == "etl", ServerRun.scope_id == target_id)
        )).scalars().all()
        await _drop([r for r in rows if (r.spec or {}).get("pipeline_id") == pipeline_id], db)


async def _forget(db: AsyncSession, *where) -> None:
    await _drop(list((await db.execute(select(ServerRun).where(*where))).scalars().all()), db)


async def _drop(rows: list[ServerRun], db: AsyncSession) -> None:
    if not rows:
        return
    going = [run for run in rows if run.status in ACTIVE_STATUSES]
    for run in going:
        await state.ask(db, run, "cancel")
    await asyncio.gather(*(executor.stop_and_wait(run.id) for run in going))
    waiting = [(run.id, run.kind) for run in rows if run.status in RESUMABLE]
    ids = [run.id for run in rows]
    for run in rows:
        await db.delete(run)
    await db.commit()
    for run_id, kind in waiting:
        await _closed(run_id, kind)
    for run_id in ids:
        await executor.forget_files(run_id)
