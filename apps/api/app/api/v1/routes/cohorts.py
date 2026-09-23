from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_project_permission, check_workspace_permission
from app.models.cohort import Cohort
from app.models.data_source import DataSource
from app.models.project import Project
from app.models.user import User
from app.schemas.cohort import CohortCreate, CohortResponse, CohortUpdate
from app.services import cohort_service

router = APIRouter(prefix="/cohorts", tags=["cohorts"])

# A database's cohorts are part of the database: reading them is reading it,
# changing or deleting one is editing it (the `databases:*` workspace permission),
# where a project's cohorts answer to the project's own `cohorts:*`.
_DATABASE_PERMISSION = {
    "cohorts:read": "databases:read",
    "cohorts:write": "databases:write",
    "cohorts:delete": "databases:write",
}


async def _require_project_access(
    db: AsyncSession, project_uid: str, user: User, permission: str
) -> None:
    """Cohort access derives from the owning project (workspace role inherited,
    with per-project override applied). Gated on the atomic `cohorts:*` permission."""
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    await check_project_permission(db, project, user, permission)


async def _require_database_access(
    db: AsyncSession, data_source_id: str, user: User, permission: str
) -> None:
    source = await db.get(DataSource, data_source_id)
    if source is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Database not found")
    if source.workspace_id is not None:
        await check_workspace_permission(
            db, source.workspace_id, user, _DATABASE_PERMISSION[permission]
        )


async def _require_owner_access(
    db: AsyncSession,
    project_uid: str | None,
    owner_data_source_id: str | None,
    user: User,
    permission: str,
) -> None:
    if project_uid:
        await _require_project_access(db, project_uid, user, permission)
    elif owner_data_source_id:
        await _require_database_access(db, owner_data_source_id, user, permission)
    else:
        # Unreachable for a stored row (the create refuses it); a cohort with no
        # owner answers to no permission, so it must not be served at all.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")


async def _load(db: AsyncSession, cohort_id: str, user: User, permission: str) -> Cohort:
    cohort = await cohort_service.get(db, cohort_id)
    if cohort is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _require_owner_access(
        db, cohort.project_uid, cohort.owner_data_source_id, user, permission
    )
    return cohort


@router.get("", response_model=list[CohortResponse])
async def list_cohorts(
    project_uid: str | None = Query(default=None, alias="projectUid"),
    data_source_id: str | None = Query(default=None, alias="dataSourceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if project_uid is not None:
        await _require_project_access(db, project_uid, user, "cohorts:read")
        return await cohort_service.list_for_project(db, project_uid)
    if data_source_id is not None:
        await _require_database_access(db, data_source_id, user, "cohorts:read")
        return await cohort_service.list_for_database(db, data_source_id)
    return await cohort_service.list_for_user(db, user)


@router.post("", response_model=CohortResponse, status_code=status.HTTP_201_CREATED)
async def create_cohort(
    body: CohortCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if bool(body.project_uid) == bool(body.owner_data_source_id):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "a cohort belongs to exactly one project or one database",
        )
    await _require_owner_access(
        db, body.project_uid, body.owner_data_source_id, user, "cohorts:write"
    )
    if body.owner_data_source_id:
        # A database's cohort runs against that database — never another one.
        body.data_source_id = body.owner_data_source_id
    return await cohort_service.create(db, body)


@router.get("/{cohort_id}", response_model=CohortResponse)
async def get_cohort(
    cohort_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load(db, cohort_id, user, "cohorts:read")


@router.patch("/{cohort_id}", response_model=CohortResponse)
async def update_cohort(
    cohort_id: str,
    body: CohortUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    cohort = await _load(db, cohort_id, user, "cohorts:write")
    if cohort.owner_data_source_id and "data_source_id" in body.model_fields_set:
        body.data_source_id = cohort.owner_data_source_id
    return await cohort_service.update(db, cohort, body)


@router.delete("/{cohort_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_cohort(
    cohort_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    cohort = await _load(db, cohort_id, user, "cohorts:delete")
    await cohort_service.delete(db, cohort)
