"""DB access for the git sync cursors (see models/git_sync_state.py).

Two cursors per (scope, entity, branch): `synced_oid` (we hold this commit's
content — the 3-way base, complete pulls only) and `reviewed_oid` (every item
this commit brought got a decision — the push gate). They move independently,
so each has its own setter and `set_oid` advances both: a push means we hold the
content *and* have nothing left to deliberate.
"""

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.git_sync_state import GitSyncState


async def get(db: AsyncSession, scope: str, entity_id: str, branch: str) -> GitSyncState | None:
    result = await db.execute(
        select(GitSyncState).where(
            GitSyncState.scope == scope,
            GitSyncState.entity_id == entity_id,
            GitSyncState.branch == branch,
        )
    )
    return result.scalar_one_or_none()


async def set_oid(db: AsyncSession, scope: str, entity_id: str, branch: str, oid: str) -> GitSyncState:
    """Advance BOTH cursors — for a push, or a pull that took everything.

    Holding the content implies having deliberated over it, so leaving
    `reviewed_oid` behind here would re-raise a "behind" state for a commit we
    fully hold.
    """
    return await _upsert(db, scope, entity_id, branch, synced=oid, reviewed=oid)


async def set_reviewed_oid(
    db: AsyncSession, scope: str, entity_id: str, branch: str, oid: str
) -> GitSyncState:
    """Advance ONLY the decision cursor — a partial pull, fully deliberated.

    The user decided on every incoming item but kept their own version of some,
    so we do NOT hold this commit's content: `synced_oid` must stay put or the
    3-way base would silently absorb what was declined. The declined items now
    show up as local changes to push, which is exactly the user's position.
    """
    return await _upsert(db, scope, entity_id, branch, synced=None, reviewed=oid)


async def _upsert(
    db: AsyncSession,
    scope: str,
    entity_id: str,
    branch: str,
    synced: str | None,
    reviewed: str | None,
) -> GitSyncState:
    now = datetime.now(timezone.utc).isoformat()
    row = await get(db, scope, entity_id, branch)
    if row is None:
        # A first-ever row needs a synced_oid (the column is NOT NULL). A
        # reviewed-only decision with no prior anchor means "I deliberated over a
        # commit whose content I don't hold" — there is no base to record, so the
        # anchor stays at the empty string rather than borrowing the reviewed oid,
        # which would claim content we never applied.
        row = GitSyncState(
            scope=scope,
            entity_id=entity_id,
            branch=branch,
            synced_oid=synced or "",
            reviewed_oid=reviewed,
            checked_at=now,
        )
        db.add(row)
    else:
        if synced is not None:
            row.synced_oid = synced
        if reviewed is not None:
            row.reviewed_oid = reviewed
        row.checked_at = now
    await db.commit()
    await db.refresh(row)
    return row
