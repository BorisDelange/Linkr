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
    result = await db.execute(
        select(GitContentStatus).where(
            GitContentStatus.scope == scope,
            GitContentStatus.entity_id == entity_id,
        )
    )
    row = result.scalar_one_or_none()
    if row is None:
        db.add(GitContentStatus(scope=scope, entity_id=entity_id, workspace_id=workspace_id, status=status))
    else:
        row.status = status
        row.workspace_id = workspace_id
    await db.commit()


async def clear(db: AsyncSession, scope: str, entity_id: str) -> None:
    await db.execute(
        delete(GitContentStatus).where(
            GitContentStatus.scope == scope,
            GitContentStatus.entity_id == entity_id,
        )
    )
    await db.commit()


async def list_for_workspace(db: AsyncSession, workspace_id: str) -> list[GitContentStatus]:
    result = await db.execute(
        select(GitContentStatus).where(GitContentStatus.workspace_id == workspace_id)
    )
    return list(result.scalars().all())
