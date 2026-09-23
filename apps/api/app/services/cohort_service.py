from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cohort import Cohort
from app.models.data_source import DataSource
from app.models.project import Project
from app.models.user import User
from app.models.workspace_member import WorkspaceMember
from app.schemas.cohort import CohortCreate, CohortUpdate


async def list_for_project(db: AsyncSession, project_uid: str) -> list[Cohort]:
    result = await db.execute(select(Cohort).where(Cohort.project_uid == project_uid))
    return list(result.scalars().all())


async def list_for_database(db: AsyncSession, data_source_id: str) -> list[Cohort]:
    result = await db.execute(select(Cohort).where(Cohort.owner_data_source_id == data_source_id))
    return list(result.scalars().all())


async def list_for_user(db: AsyncSession, user: User) -> list[Cohort]:
    """Cohorts the user can reach — in their workspaces' projects and databases
    (admins see all). The store loads everything then filters by owner
    client-side."""
    if user.role == "admin":
        result = await db.execute(select(Cohort))
        return list(result.scalars().all())

    member_workspaces = select(WorkspaceMember.workspace_id).where(WorkspaceMember.user_id == user.id)
    in_projects = (
        select(Cohort)
        .join(Project, Project.uid == Cohort.project_uid)
        .where(Project.workspace_id.in_(member_workspaces))
    )
    in_databases = (
        select(Cohort)
        .join(DataSource, DataSource.id == Cohort.owner_data_source_id)
        .where(DataSource.workspace_id.in_(member_workspaces))
    )
    projects = (await db.execute(in_projects)).scalars().all()
    databases = (await db.execute(in_databases)).scalars().all()
    return [*projects, *databases]


async def get(db: AsyncSession, cohort_id: str) -> Cohort | None:
    return await db.get(Cohort, cohort_id)


async def create(db: AsyncSession, data: CohortCreate) -> Cohort:
    cohort = Cohort(**data.model_dump(exclude_none=True))
    db.add(cohort)
    await db.commit()
    await db.refresh(cohort)
    return cohort


async def update(db: AsyncSession, cohort: Cohort, data: CohortUpdate) -> Cohort:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(cohort, key, value)
    await db.commit()
    await db.refresh(cohort)
    return cohort


async def delete(db: AsyncSession, cohort: Cohort) -> None:
    await db.delete(cohort)
    await db.commit()


async def delete_for_project(db: AsyncSession, project_uid: str) -> None:
    await db.execute(sa_delete(Cohort).where(Cohort.project_uid == project_uid))
    await db.commit()
