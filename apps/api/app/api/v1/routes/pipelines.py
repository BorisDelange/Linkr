from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_role
from app.models.pipeline import Pipeline
from app.models.project import Project
from app.models.user import User
from app.schemas.pipeline import PipelineCreate, PipelineResponse, PipelineUpdate
from app.services import pipeline_service

router = APIRouter(prefix="/pipelines", tags=["pipelines"])


async def _require_project_access(
    db: AsyncSession, project_uid: str, user: User, min_role: str
) -> None:
    """Pipeline access derives from the owning project's workspace membership."""
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    if project.workspace_id is not None:
        await check_workspace_role(db, project.workspace_id, user, min_role)


async def _load(
    db: AsyncSession, pipeline_id: str, user: User, min_role: str
) -> Pipeline:
    pipeline = await pipeline_service.get(db, pipeline_id)
    if pipeline is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _require_project_access(db, pipeline.project_uid, user, min_role)
    return pipeline


@router.get("", response_model=list[PipelineResponse])
async def list_pipelines(
    project_uid: str | None = Query(default=None, alias="projectUid"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if project_uid is not None:
        await _require_project_access(db, project_uid, user, "viewer")
        return await pipeline_service.list_for_project(db, project_uid)
    return await pipeline_service.list_for_user(db, user)


@router.post("", response_model=PipelineResponse, status_code=status.HTTP_201_CREATED)
async def create_pipeline(
    body: PipelineCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project_access(db, body.project_uid, user, "editor")
    return await pipeline_service.create(db, body)


@router.get("/{pipeline_id}", response_model=PipelineResponse)
async def get_pipeline(
    pipeline_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load(db, pipeline_id, user, "viewer")


@router.patch("/{pipeline_id}", response_model=PipelineResponse)
async def update_pipeline(
    pipeline_id: str,
    body: PipelineUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    pipeline = await _load(db, pipeline_id, user, "editor")
    return await pipeline_service.update(db, pipeline, body)


@router.delete("/{pipeline_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_pipeline(
    pipeline_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    pipeline = await _load(db, pipeline_id, user, "editor")
    await pipeline_service.delete(db, pipeline)
