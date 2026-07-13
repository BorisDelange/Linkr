"""DB access for the git sync anchor (see models/git_sync_state.py).

Records the last remote OID an entity/branch was synced with. Read to compute
behind/diverged; written on push and on the lazy first-clean-sync adoption.
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
    now = datetime.now(timezone.utc).isoformat()
    row = await get(db, scope, entity_id, branch)
    if row is None:
        row = GitSyncState(scope=scope, entity_id=entity_id, branch=branch, synced_oid=oid, checked_at=now)
        db.add(row)
    else:
        row.synced_oid = oid
        row.checked_at = now
    await db.commit()
    await db.refresh(row)
    return row
