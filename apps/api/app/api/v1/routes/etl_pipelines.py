from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
from app.models.etl_pipeline import EtlFile, EtlPipeline, EtlRunHistory
from app.models.user import User
from app.schemas.etl_pipeline import (
    EtlFileCreate,
    EtlFileResponse,
    EtlFileUpdate,
    EtlPipelineCreate,
    EtlPipelineResponse,
    EtlPipelineUpdate,
    EtlRunHistoryCreate,
    EtlRunHistoryResponse,
    EtlRunHistoryUpdate,
)
from app.schemas.stats_cache import StatsCacheResponse, StatsCacheSave
from app.services import etl_pipeline_service, stats_cache_service

router = APIRouter(tags=["etl-pipelines"])

_PIPE = "/etl-pipelines"
_FILE = "/etl-files"
_RUN = "/etl-runs"


async def _load_pipeline(
    db: AsyncSession, pipeline_id: str, user: User, permission: str
) -> EtlPipeline:
    pipeline = await etl_pipeline_service.get(db, pipeline_id)
    if pipeline is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_permission(db, pipeline.workspace_id, user, permission)
    return pipeline


async def _load_file(
    db: AsyncSession, file_id: str, user: User, permission: str
) -> EtlFile:
    node = await etl_pipeline_service.get_file(db, file_id)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _load_pipeline(db, node.pipeline_id, user, permission)
    return node


async def _load_run(
    db: AsyncSession, run_id: str, user: User, permission: str
) -> EtlRunHistory:
    run = await etl_pipeline_service.get_run(db, run_id)
    if run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _load_pipeline(db, run.pipeline_id, user, permission)
    return run


# --- Pipelines -------------------------------------------------------------

@router.get(_PIPE, response_model=list[EtlPipelineResponse])
async def list_pipelines(
    workspace_id: str | None = Query(default=None, alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if workspace_id is not None:
        await check_workspace_permission(db, workspace_id, user, "etl:read")
        return await etl_pipeline_service.list_for_workspace(db, workspace_id)
    # No filter: every pipeline the user can see (mirrors sql-scripts listing).
    pipelines = await etl_pipeline_service.list_all(db)
    visible: list[EtlPipeline] = []
    for p in pipelines:
        try:
            await check_workspace_permission(db, p.workspace_id, user, "etl:read")
            visible.append(p)
        except HTTPException:
            continue
    return visible


@router.post(_PIPE, response_model=EtlPipelineResponse, status_code=status.HTTP_201_CREATED)
async def create_pipeline(
    body: EtlPipelineCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, body.workspace_id, user, "etl:write")
    return await etl_pipeline_service.create(db, body)


@router.get(_PIPE + "/{pipeline_id}", response_model=EtlPipelineResponse)
async def get_pipeline(
    pipeline_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load_pipeline(db, pipeline_id, user, "etl:read")


@router.patch(_PIPE + "/{pipeline_id}", response_model=EtlPipelineResponse)
async def update_pipeline(
    pipeline_id: str,
    body: EtlPipelineUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    pipeline = await _load_pipeline(db, pipeline_id, user, "etl:write")
    return await etl_pipeline_service.update(db, pipeline, body)


@router.delete(_PIPE + "/{pipeline_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_pipeline(
    pipeline_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    pipeline = await _load_pipeline(db, pipeline_id, user, "etl:delete")
    await etl_pipeline_service.delete(db, pipeline)


# --- Files -----------------------------------------------------------------

@router.get(_PIPE + "/{pipeline_id}/files", response_model=list[EtlFileResponse])
async def list_files(
    pipeline_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_pipeline(db, pipeline_id, user, "etl:read")
    return await etl_pipeline_service.list_files(db, pipeline_id)


@router.delete(_PIPE + "/{pipeline_id}/files", status_code=status.HTTP_204_NO_CONTENT)
async def delete_files_for_pipeline(
    pipeline_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_pipeline(db, pipeline_id, user, "etl:delete")
    await etl_pipeline_service.delete_files_for_pipeline(db, pipeline_id)


@router.post(_FILE, response_model=EtlFileResponse, status_code=status.HTTP_201_CREATED)
async def create_file(
    body: EtlFileCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_pipeline(db, body.pipeline_id, user, "etl:write")
    return await etl_pipeline_service.create_file(db, body)


@router.patch(_FILE + "/{file_id}", response_model=EtlFileResponse)
async def update_file(
    file_id: str,
    body: EtlFileUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    node = await _load_file(db, file_id, user, "etl:write")
    return await etl_pipeline_service.update_file(db, node, body)


@router.delete(_FILE + "/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_file(
    file_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    node = await _load_file(db, file_id, user, "etl:delete")
    await etl_pipeline_service.delete_file(db, node)


# --- Run history -----------------------------------------------------------

@router.get(_PIPE + "/{pipeline_id}/runs", response_model=list[EtlRunHistoryResponse])
async def list_runs(
    pipeline_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_pipeline(db, pipeline_id, user, "etl:read")
    return await etl_pipeline_service.list_runs(db, pipeline_id)


@router.post(_RUN, response_model=EtlRunHistoryResponse, status_code=status.HTTP_201_CREATED)
async def create_run(
    body: EtlRunHistoryCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Authorized through the pipeline's workspace, which is why pipeline_id is
    # required on the schema rather than optional.
    await _load_pipeline(db, body.pipeline_id, user, "etl:write")
    return await etl_pipeline_service.create_run(db, body, user_id=user.id)


@router.patch(_RUN + "/{run_id}", response_model=EtlRunHistoryResponse)
async def update_run(
    run_id: str,
    body: EtlRunHistoryUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    run = await _load_run(db, run_id, user, "etl:write")
    return await etl_pipeline_service.update_run(db, run, body)


@router.delete(_RUN + "/{run_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_run(
    run_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    run = await _load_run(db, run_id, user, "etl:delete")
    await etl_pipeline_service.delete_run(db, run)


@router.delete(_PIPE + "/{pipeline_id}/runs", status_code=status.HTTP_204_NO_CONTENT)
async def delete_runs_for_pipeline(
    pipeline_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_pipeline(db, pipeline_id, user, "etl:delete")
    await etl_pipeline_service.delete_runs_for_pipeline(db, pipeline_id)


# --- Quality-check cache ---------------------------------------------------

# A third scope on the shared stats_cache table (alongside 'database' and
# 'catalog'): the quality-check concept table is an expensive derived result
# (one STCM read + two GROUP BYs per OMOP clinical table) that only changes when
# the pipeline runs, so it belongs in the same shared, recomputable cache rather
# than in each user's browser.
_QUALITY_SCOPE = "etl-quality"


@router.get(
    _PIPE + "/{pipeline_id}/quality-cache",
    response_model=StatsCacheResponse | None,
)
async def get_quality_cache(
    pipeline_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The shared per-concept quality table for this pipeline (null if none)."""
    await _load_pipeline(db, pipeline_id, user, "etl:read")
    row = await stats_cache_service.get(db, _QUALITY_SCOPE, pipeline_id)
    if row is None:
        return None
    return StatsCacheResponse(computed_at=row.computed_at, payload=row.payload)


@router.put(
    _PIPE + "/{pipeline_id}/quality-cache",
    response_model=StatsCacheResponse,
)
async def save_quality_cache(
    pipeline_id: str,
    body: StatsCacheSave,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Store the table a client just computed, sharing it with the workspace."""
    await _load_pipeline(db, pipeline_id, user, "etl:write")
    row = await stats_cache_service.save(
        db, _QUALITY_SCOPE, pipeline_id, body.computed_at, body.payload
    )
    return StatsCacheResponse(computed_at=row.computed_at, payload=row.payload)


@router.delete(
    _PIPE + "/{pipeline_id}/quality-cache",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_quality_cache(
    pipeline_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Drop the shared table (the Refresh button). A recompute, so write — not
    delete — permission, mirroring the database stats cache."""
    await _load_pipeline(db, pipeline_id, user, "etl:write")
    await stats_cache_service.delete(db, _QUALITY_SCOPE, pipeline_id)
