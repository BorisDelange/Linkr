from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_project_permission
from app.models.cohort import Cohort
from app.models.project import Project
from app.models.user import User
from app.schemas.cohort import CohortCreate, CohortResponse, CohortUpdate
from app.services import cohort_service

router = APIRouter(prefix="/cohorts", tags=["cohorts"])


async def _require_project_access(
    db: AsyncSession, project_uid: str, user: User, permission: str
) -> None:
    """Cohort access derives from the owning project (workspace role inherited,
    with per-project override applied). Gated on the atomic `cohorts:*` permission."""
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    await check_project_permission(db, project, user, permission)


async def _load(db: AsyncSession, cohort_id: str, user: User, permission: str) -> Cohort:
    cohort = await cohort_service.get(db, cohort_id)
    if cohort is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _require_project_access(db, cohort.project_uid, user, permission)
    return cohort


@router.get("", response_model=list[CohortResponse])
async def list_cohorts(
    project_uid: str | None = Query(default=None, alias="projectUid"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if project_uid is not None:
        await _require_project_access(db, project_uid, user, "cohorts:read")
        return await cohort_service.list_for_project(db, project_uid)
    return await cohort_service.list_for_user(db, user)


@router.post("", response_model=CohortResponse, status_code=status.HTTP_201_CREATED)
async def create_cohort(
    body: CohortCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project_access(db, body.project_uid, user, "cohorts:write")
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
    return await cohort_service.update(db, cohort, body)


@router.delete("/{cohort_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_cohort(
    cohort_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    cohort = await _load(db, cohort_id, user, "cohorts:delete")
    await cohort_service.delete(db, cohort)
