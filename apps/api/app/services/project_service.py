from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import Project
from app.models.project_member import ProjectMember
from app.models.user import User
from app.models.workspace_member import WorkspaceMember
from app.schemas.project import ProjectCreate, ProjectUpdate


async def list_for_user(db: AsyncSession, user: User) -> list[Project]:
    """Projects the user can reach (admins see all).

    A project is visible when the user has a role on its workspace (inherited) OR
    a per-project override grants them a role directly — the latter lets a project
    be shared with someone who isn't a workspace member. A "none" override hides
    the project even from a workspace member."""
    if user.role == "admin":
        result = await db.execute(select(Project))
        return list(result.scalars().all())

    my_workspaces = select(WorkspaceMember.workspace_id).where(
        WorkspaceMember.user_id == user.id
    )
    hidden = select(ProjectMember.project_uid).where(
        ProjectMember.user_id == user.id, ProjectMember.role == "none"
    )
    granted = select(ProjectMember.project_uid).where(
        ProjectMember.user_id == user.id, ProjectMember.role != "none"
    )
    result = await db.execute(
        select(Project).where(
            or_(
                and_(
                    Project.workspace_id.in_(my_workspaces),
                    Project.uid.notin_(hidden),
                ),
                Project.uid.in_(granted),
            )
        )
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
