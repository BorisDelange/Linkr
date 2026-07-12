import shutil

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.permissions import global_grant_role
from app.models.project import Project
from app.models.project_member import ProjectMember
from app.models.user import User
from app.models.workspace_member import WorkspaceMember
from app.schemas.project import ProjectCreate, ProjectUpdate
from app.services import blob_cleanup, git_secret, project_fs


async def list_for_user(db: AsyncSession, user: User) -> list[Project]:
    """Projects the user can reach (admins see all).

    A project is visible when the user has a role on its workspace (inherited) OR
    a per-project override grants them a role directly — the latter lets a project
    be shared with someone who isn't a workspace member. A "none" override hides
    the project even from a workspace member. A global "all-projects" grant sees
    every project (like admin, but configurable)."""
    if user.role == "admin" or await global_grant_role(db, user, "all-projects"):
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
    payload = data.model_dump(exclude_none=True)
    project = Project(owner_id=owner.id)
    git_secret.apply_to_entity(project, payload)
    for key, value in payload.items():
        setattr(project, key, value)
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return project


async def update(
    db: AsyncSession, project: Project, data: ProjectUpdate
) -> Project:
    changes = data.model_dump(exclude_unset=True)
    git_secret.apply_to_entity(project, changes)
    for key, value in changes.items():
        setattr(project, key, value)
    await db.commit()
    await db.refresh(project)
    return project


async def delete(db: AsyncSession, project: Project) -> None:
    project_uid = project.uid
    shas = await blob_cleanup.collect_project_blob_shas(db, project_uid)

    await db.delete(project)
    await db.commit()

    # Disk cleanup after the DB commit: the project's working directory
    # (scripts/, datasets/, .cache/) is never shared with another project, so
    # it's safe to remove outright. Blobs are content-addressed and may be
    # shared (e.g. a duplicated mapping project) — deref_blobs only deletes
    # ones no longer referenced by any row anywhere.
    shutil.rmtree(project_fs.project_dir(project_uid), ignore_errors=True)
    await blob_cleanup.deref_blobs(db, shas)
