from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import Project
from app.models.user import User
from app.models.workspace_member import WorkspaceMember
from app.schemas.project import ProjectCreate, ProjectUpdate


async def list_for_user(db: AsyncSession, user: User) -> list[Project]:
    """Projects in workspaces the user is a member of (admins see all)."""
    if user.role == "admin":
        result = await db.execute(select(Project))
        return list(result.scalars().all())

    result = await db.execute(
        select(Project)
        .join(
            WorkspaceMember,
            WorkspaceMember.workspace_id == Project.workspace_id,
        )
        .where(WorkspaceMember.user_id == user.id)
    )
    return list(result.scalars().all())


async def get(db: AsyncSession, project_uid: str) -> Project | None:
    return await db.get(Project, project_uid)


async def create(db: AsyncSession, data: ProjectCreate, owner: User) -> Project:
    project = Project(**data.model_dump(exclude_none=True), owner_id=owner.id)
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return project


async def update(
    db: AsyncSession, project: Project, data: ProjectUpdate
) -> Project:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(project, key, value)
    await db.commit()
    await db.refresh(project)
    return project


async def delete(db: AsyncSession, project: Project) -> None:
    await db.delete(project)
    await db.commit()
