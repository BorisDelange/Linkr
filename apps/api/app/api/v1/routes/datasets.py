from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_role
from app.models.dataset import DatasetFile
from app.models.project import Project
from app.models.user import User
from app.schemas.dataset import (
    DatasetAnalysisCreate,
    DatasetAnalysisResponse,
    DatasetAnalysisUpdate,
    DatasetDataResponse,
    DatasetDataWrite,
    DatasetFileCreate,
    DatasetFileResponse,
    DatasetFileUpdate,
    DatasetImportRequest,
    DatasetReimportRequest,
)
from app.services import dataset_service

router = APIRouter(prefix="/datasets", tags=["datasets"])


async def _require_project_access(
    db: AsyncSession, project_uid: str, user: User, min_role: str
) -> None:
    """Dataset access derives from the owning project's workspace membership."""
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    if project.workspace_id is not None:
        await check_workspace_role(db, project.workspace_id, user, min_role)


async def _load_file(
    db: AsyncSession, file_id: str, user: User, min_role: str
) -> DatasetFile:
    node = await dataset_service.get(db, file_id)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _require_project_access(db, node.project_uid, user, min_role)
    return node


@router.get("", response_model=list[DatasetFileResponse])
async def list_datasets(
    project_uid: str = Query(alias="projectUid"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project_access(db, project_uid, user, "viewer")
    return await dataset_service.list_for_project(db, project_uid)


@router.post("", response_model=DatasetFileResponse, status_code=status.HTTP_201_CREATED)
async def create_dataset(
    body: DatasetFileCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project_access(db, body.project_uid, user, "editor")
    return await dataset_service.create(db, body, user)


@router.post("/import", response_model=DatasetFileResponse, status_code=status.HTTP_201_CREATED)
async def import_dataset(
    body: DatasetImportRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project_access(db, body.project_uid, user, "editor")
    return await dataset_service.import_file(db, body, user)


@router.get("/{file_id}", response_model=DatasetFileResponse)
async def get_dataset(
    file_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load_file(db, file_id, user, "viewer")


@router.patch("/{file_id}", response_model=DatasetFileResponse)
async def update_dataset(
    file_id: str,
    body: DatasetFileUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    node = await _load_file(db, file_id, user, "editor")
    return await dataset_service.update(db, node, body)


@router.delete("/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dataset(
    file_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    node = await _load_file(db, file_id, user, "editor")
    await dataset_service.delete(db, node)


@router.post("/{file_id}/reimport", response_model=DatasetFileResponse)
async def reimport_dataset(
    file_id: str,
    body: DatasetReimportRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    node = await _load_file(db, file_id, user, "editor")
    try:
        return await dataset_service.reimport_file(db, node, body.parse_options)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))


# --- Row data --------------------------------------------------------------

@router.get("/{file_id}/data", response_model=DatasetDataResponse)
async def get_dataset_data(
    file_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    node = await _load_file(db, file_id, user, "viewer")
    return DatasetDataResponse(rows=await dataset_service.read_rows(node))


@router.put("/{file_id}/data", status_code=status.HTTP_204_NO_CONTENT)
async def put_dataset_data(
    file_id: str,
    body: DatasetDataWrite,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    node = await _load_file(db, file_id, user, "editor")
    await dataset_service.write_rows(db, node, body.rows)


# --- Analyses --------------------------------------------------------------

@router.get("/{file_id}/analyses", response_model=list[DatasetAnalysisResponse])
async def list_analyses(
    file_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_file(db, file_id, user, "viewer")
    return await dataset_service.list_analyses(db, file_id)


@router.post("/{file_id}/analyses", response_model=DatasetAnalysisResponse, status_code=status.HTTP_201_CREATED)
async def create_analysis(
    file_id: str,
    body: DatasetAnalysisCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_file(db, file_id, user, "editor")
    return await dataset_service.create_analysis(db, body)


@router.patch("/analyses/{analysis_id}", response_model=DatasetAnalysisResponse)
async def update_analysis(
    analysis_id: str,
    body: DatasetAnalysisUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    a = await dataset_service.get_analysis(db, analysis_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _load_file(db, a.dataset_file_id, user, "editor")
    return await dataset_service.update_analysis(db, a, body)


@router.delete("/analyses/{analysis_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_analysis(
    analysis_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    a = await dataset_service.get_analysis(db, analysis_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _load_file(db, a.dataset_file_id, user, "editor")
    await dataset_service.delete_analysis(db, a)
