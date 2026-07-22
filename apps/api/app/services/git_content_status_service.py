"""DB access for the git-linked content reconstitution status
(see models/git_content_status.py).

A row means the entity's content is not reconstituted yet: ``pending`` (clone not
done) or ``failed`` (clone errored). A successful clone clears the row, so absence
means "reconstituted / normal". Read by the UI to badge entity cards + offer retry.
"""

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.git_content_status import GitContentStatus


async def set_status(
    db: AsyncSession, scope: str, entity_id: str, workspace_id: str, status: str
) -> None:
    # The row is keyed by (scope, entity_id) — entity ids are globally unique, so a
    # row never legitimately belongs to two workspaces. workspace_id is always the
    # path-authorized one (the route ignores any body value). If an existing row is
    # tagged to a DIFFERENT workspace, the caller isn't authorized for that entity,
    # so leave it untouched rather than reparent or overwrite it.
    result = await db.execute(
        select(GitContentStatus).where(
            GitContentStatus.scope == scope,
            GitContentStatus.entity_id == entity_id,
        )
    )
    row = result.scalar_one_or_none()
    if row is None:
        db.add(GitContentStatus(scope=scope, entity_id=entity_id, workspace_id=workspace_id, status=status))
    elif row.workspace_id == workspace_id:
        row.status = status
    else:
        return
    await db.commit()


async def clear(db: AsyncSession, workspace_id: str, scope: str, entity_id: str) -> None:
    # Only clear the row when it belongs to the authorized workspace (see set_status).
    await db.execute(
        delete(GitContentStatus).where(
            GitContentStatus.scope == scope,
            GitContentStatus.entity_id == entity_id,
            GitContentStatus.workspace_id == workspace_id,
        )
    )
    await db.commit()


async def list_for_workspace(db: AsyncSession, workspace_id: str) -> list[GitContentStatus]:
    result = await db.execute(
        select(GitContentStatus).where(GitContentStatus.workspace_id == workspace_id)
    )
    return list(result.scalars().all())
