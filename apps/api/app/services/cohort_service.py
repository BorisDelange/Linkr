from datetime import datetime

from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.permissions import has_permission, has_project_permission
from app.models.cohort import Cohort
from app.models.data_source import DataSource
from app.models.user import User
from app.schemas.cohort import CohortCreate, CohortUpdate
from app.services import project_service


async def list_for_project(db: AsyncSession, project_uid: str) -> list[Cohort]:
    result = await db.execute(select(Cohort).where(Cohort.project_uid == project_uid))
    return list(result.scalars().all())


async def list_for_database(db: AsyncSession, data_source_id: str) -> list[Cohort]:
    result = await db.execute(select(Cohort).where(Cohort.owner_data_source_id == data_source_id))
    return list(result.scalars().all())


async def list_for_user(db: AsyncSession, user: User) -> list[Cohort]:
    """Cohorts the user may read: those of the projects they see (project_service's
    visibility: workspace role, per-project grant, all-projects grant, "none"
    override) where they hold `cohorts:read`, and those of the databases whose
    workspace grants them `databases:read` — the checks `cohort_access` applies to
    one cohort (admins see all)."""
    if user.role == "admin":
        result = await db.execute(select(Cohort))
        return list(result.scalars().all())

    readable_projects = [
        p.uid for p in await project_service.list_for_user(db, user)
        if await has_project_permission(db, p, user, "cohorts:read")
    ]
    database_workspaces = (
        await db.execute(
            select(DataSource.workspace_id).where(DataSource.workspace_id.is_not(None)).distinct()
        )
    ).scalars().all()
    readable_workspaces = [
        ws for ws in database_workspaces if await has_permission(db, ws, user, "databases:read")
    ]
    in_projects = select(Cohort).where(Cohort.project_uid.in_(readable_projects))
    in_databases = (
        select(Cohort)
        .join(DataSource, DataSource.id == Cohort.owner_data_source_id)
        .where(DataSource.workspace_id.in_(readable_workspaces))
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


def _member_id(value) -> str:
    # As the browser's String(): an integral DOUBLE reads "5", not "5.0".
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def build_materialization(
    level: str, ids: list, patient_ids: list, materialized_at: datetime
) -> dict:
    """The frozen membership stored on a cohort (CohortMaterialization on the
    front), from the `id` and `patient_id` columns of its membership query."""
    members = [_member_id(v) for v in ids if v is not None]
    patients = dict.fromkeys(_member_id(v) for v in patient_ids if v is not None)
    return {
        "level": level,
        "ids": members,
        "patientIds": list(patients),
        "count": len(members),
        "materializedAt": materialized_at.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }
