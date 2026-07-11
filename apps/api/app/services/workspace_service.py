from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.permissions import global_grant_role
from app.models.user import User
from app.models.workspace import Workspace
from app.models.workspace_member import WorkspaceMember
from app.schemas.workspace import WorkspaceCreate, WorkspaceUpdate


async def list_for_user(db: AsyncSession, user: User) -> list[Workspace]:
    """Workspaces the user is a member of (admins see all; a global
    all-workspaces grant sees all too)."""
    if user.role == "admin" or await global_grant_role(db, user, "all-workspaces"):
        result = await db.execute(select(Workspace))
        return list(result.scalars().all())

    result = await db.execute(
        select(Workspace)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user.id)
    )
    return list(result.scalars().all())


async def get(db: AsyncSession, workspace_id: str) -> Workspace | None:
    return await db.get(Workspace, workspace_id)


async def create(db: AsyncSession, data: WorkspaceCreate, owner: User) -> Workspace:
    workspace = Workspace(
        **data.model_dump(exclude_none=True),
        owner_id=owner.id,
    )
    db.add(workspace)
    await db.flush()  # assign id before adding the membership row
    db.add(
        WorkspaceMember(workspace_id=workspace.id, user_id=owner.id, role="owner")
    )
    await db.commit()
    await db.refresh(workspace)
    return workspace


async def update(
    db: AsyncSession, workspace: Workspace, data: WorkspaceUpdate
) -> Workspace:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(workspace, key, value)
    await db.commit()
    await db.refresh(workspace)
    return workspace


async def delete(db: AsyncSession, workspace: Workspace) -> None:
    await db.delete(workspace)
    await db.commit()
