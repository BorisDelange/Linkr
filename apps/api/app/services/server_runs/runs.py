"""What the routes and the startup ask of server runs: start one, pause it,
resume it, and take back those a server restart cut."""

import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import database
from app.models.server_run import ACTIVE_STATUSES, ServerRun
from app.services.server_runs import executor, registry, state

logger = logging.getLogger(__name__)

RESUMABLE = ("paused", "interrupted", "failed")


def _label(run: ServerRun) -> str:
    return str((run.spec or {}).get("label") or run.kind)


async def start(
    db: AsyncSession, *, kind: str, scope_id: str, data_source_id: str | None, workspace_id: str | None,
    user_id: int, spec: dict,
) -> ServerRun:
    """The run going on for this kind and scope, or a new one: a second start — a
    second tab, a click during a reload — follows the first rather than run
    beside it. A paused one the new run replaces is closed. `spec` is validated."""
    model = registry.KINDS[kind].spec.model_validate(spec)
    previous = await state.latest(db, kind, scope_id)
    run, created = await state.create(
        db, kind=kind, scope_id=scope_id, data_source_id=data_source_id, workspace_id=workspace_id,
        user_id=user_id, spec=model.model_dump(), initial=registry.KINDS[kind].initial(model),
    )
    if not created:
        return run
    for pruned in await state.prune(db, kind, scope_id):
        executor.drop_files(pruned)
    if previous is not None and previous.status in RESUMABLE:
        previous.status = "cancelled"
        previous.finished_at = previous.finished_at or datetime.now(UTC)
        await db.commit()
        executor.drop_files(previous.id)
    await executor.launch(run, _label(run))
    return run


async def pause(db: AsyncSession, run: ServerRun, action: str = "pause") -> ServerRun:
    """Ask for the stop: a running run stops at once — its step in flight cut,
    and done again on resume."""
    run = await state.ask(db, run, action)
    if run.status == "pausing" and not executor.stop(run.id):
        # No executor here (it died with an earlier process): nothing will act on it.
        run.status = "cancelled" if action == "cancel" else "paused"
        run.finished_at = datetime.now(UTC)
        await db.commit()
        await db.refresh(run)
    return run


async def resume(db: AsyncSession, run: ServerRun, user_id: int, spec: dict | None = None) -> ServerRun:
    """Queue a paused, interrupted or failed run again where it stopped. `spec`:
    compiled again by the page, for a kind that takes one (`Kind.respec`) — the
    steps done stay done."""
    if run.status in ACTIVE_STATUSES:
        return run
    if run.status not in RESUMABLE:
        raise ValueError(f"a {run.status} run cannot be resumed")
    if spec is not None:
        kind = registry.KINDS[run.kind]
        if kind.respec is None:
            raise ValueError(f"a {run.kind} run resumes with the spec it started with")
        model = kind.spec.model_validate(spec)
        run.state = kind.respec(dict(run.state or {}), model)
        run.spec = model.model_dump()
    run = await state.requeue(db, run, user_id)
    await executor.launch(run, _label(run))
    return run


async def recover_on_startup() -> None:
    """Runs an earlier process left going on: interrupted, then resumed — they
    pick up at their last checkpoint. One that cannot read its database without
    its user (a session-only login) stays interrupted until they resume it."""
    async with database.async_session() as db:
        orphans = await state.orphans(db)
        for run in orphans:
            run.status = "interrupted"
            run.requested = None
        await db.commit()
        for run in orphans:
            kind = registry.KINDS.get(run.kind)
            if kind is None or not kind.resume_on_startup:
                continue
            try:
                await resume(db, run, run.user_id)
            except Exception:  # noqa: BLE001 — one run that cannot resume must not stop the others
                logger.exception("server run %s could not resume", run.id)


async def forget(db: AsyncSession, kinds: tuple[str, ...], scope_ids: list[str]) -> None:
    """Drop the runs of these scopes, and their files — what they read goes (a
    cohort's member ids): a run going on is stopped first."""
    if not scope_ids:
        return
    rows = (await db.execute(
        select(ServerRun).where(ServerRun.kind.in_(kinds), ServerRun.scope_id.in_(scope_ids))
    )).scalars().all()
    for run in rows:
        executor.stop(run.id)
        executor.drop_files(run.id)
        await db.delete(run)
    await db.commit()
