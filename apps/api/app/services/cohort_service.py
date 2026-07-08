from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cohort import Cohort
from app.models.project import Project
from app.models.user import User
from app.models.workspace_member import WorkspaceMember
from app.schemas.cohort import CohortCreate, CohortUpdate


async def list_for_project(db: AsyncSession, project_uid: str) -> list[Cohort]:
    result = await db.execute(select(Cohort).where(Cohort.project_uid == project_uid))
    return list(result.scalars().all())


async def list_for_user(db: AsyncSession, user: User) -> list[Cohort]:
    """Cohorts in projects the user can reach (admins see all). The store loads
    everything then filters by project client-side; scope to accessible
    workspaces in server mode."""
    if user.role == "admin":
        result = await db.execute(select(Cohort))
        return list(result.scalars().all())

    result = await db.execute(
        select(Cohort)
        .join(Project, Project.uid == Cohort.project_uid)
        .join(
            WorkspaceMember,
            WorkspaceMember.workspace_id == Project.workspace_id,
        )
        .where(WorkspaceMember.user_id == user.id)
    )
    return list(result.scalars().all())


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
