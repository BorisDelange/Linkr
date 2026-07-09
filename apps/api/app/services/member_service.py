from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project_member import ProjectMember
from app.models.user import User
from app.models.workspace_member import WorkspaceMember

VALID_ROLES = ("viewer", "editor", "owner")


async def list_workspace_members(
    db: AsyncSession, workspace_id: str
) -> list[tuple[WorkspaceMember, User]]:
    result = await db.execute(
        select(WorkspaceMember, User)
        .join(User, User.id == WorkspaceMember.user_id)
        .where(WorkspaceMember.workspace_id == workspace_id)
        .order_by(User.username)
    )
    return [tuple(row) for row in result.all()]


async def upsert_workspace_member(
    db: AsyncSession, workspace_id: str, user_id: int, role: str
) -> WorkspaceMember:
    member = await db.get(WorkspaceMember, (workspace_id, user_id))
    if member is None:
        member = WorkspaceMember(workspace_id=workspace_id, user_id=user_id, role=role)
        db.add(member)
    else:
        member.role = role
    await db.commit()
    await db.refresh(member)
    return member


async def remove_workspace_member(
    db: AsyncSession, workspace_id: str, user_id: int
) -> bool:
    member = await db.get(WorkspaceMember, (workspace_id, user_id))
    if member is None:
        return False
    await db.delete(member)
    await db.commit()
    return True


async def count_workspace_owners(db: AsyncSession, workspace_id: str) -> int:
    result = await db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.role == "owner",
        )
    )
    return len(result.scalars().all())


async def list_project_members(
    db: AsyncSession, project_uid: str
) -> list[tuple[ProjectMember, User]]:
    result = await db.execute(
        select(ProjectMember, User)
        .join(User, User.id == ProjectMember.user_id)
        .where(ProjectMember.project_uid == project_uid)
        .order_by(User.username)
    )
    return [tuple(row) for row in result.all()]


async def upsert_project_member(
    db: AsyncSession, project_uid: str, user_id: int, role: str
) -> ProjectMember:
    member = await db.get(ProjectMember, (project_uid, user_id))
    if member is None:
        member = ProjectMember(project_uid=project_uid, user_id=user_id, role=role)
        db.add(member)
    else:
        member.role = role
    await db.commit()
    await db.refresh(member)
    return member


async def remove_project_member(
    db: AsyncSession, project_uid: str, user_id: int
) -> bool:
    member = await db.get(ProjectMember, (project_uid, user_id))
    if member is None:
        return False
    await db.delete(member)
    await db.commit()
    return True
