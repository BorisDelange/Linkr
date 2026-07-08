from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_role
from app.models.dataset import DatasetFile
from app.models.project import Project
from app.models.user import User
from app.schemas.dataset import (
    DatasetDataResponse,
    DatasetDataWrite,
    DatasetFileCreate,
    DatasetFileResponse,
    DatasetFileUpdate,
    DatasetDuplicateRequest,
    DatasetImportRequest,
    DatasetReimportRequest,
    DatasetRowsPage,
    DatasetRowsQuery,
)
from app.services import blob_store, dataset_service

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
    if not blob_store.exists(body.sha):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Uploaded file not found — the upload may not have completed.",
        )
    try:
        return await dataset_service.import_file(db, body, user)
    except dataset_service.DatasetParseError as e:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, f"Could not parse the file: {e}"
        )


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


@router.post("/{file_id}/duplicate", response_model=DatasetFileResponse, status_code=status.HTTP_201_CREATED)
async def duplicate_dataset(
    file_id: str,
    body: DatasetDuplicateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    node = await _load_file(db, file_id, user, "editor")
    return await dataset_service.duplicate(db, node, body.name, user)


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
    except dataset_service.DatasetParseError as e:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, f"Could not parse the file: {e}"
        )
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


@router.post("/{file_id}/rows/query", response_model=DatasetRowsPage)
async def query_dataset_rows(
    file_id: str,
    body: DatasetRowsQuery,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """A filtered/sorted/paginated page of rows, computed server-side.

    The counterpart to DatasetTable's client-side work — the browser fetches one
    page instead of the whole dataset."""
    node = await _load_file(db, file_id, user, "viewer")
    filters = [
        {
            "colId": f.col_id,
            "value": f.value,
            "min": f.min,
            "max": f.max,
            "from": f.from_,
            "to": f.to,
        }
        for f in body.filters
    ]
    na = [{"colId": n.col_id, "mode": n.mode} for n in body.na]
    sort = {"colId": body.sort.col_id, "dir": body.sort.dir} if body.sort else None
    rows, total = await dataset_service.query_rows(
        node,
        offset=body.offset,
        limit=body.limit,
        sort=sort,
        filters=filters,
        na=na,
    )
    return DatasetRowsPage(rows=rows, total=total)


@router.get("/{file_id}/columns/{col_id}/stats")
async def get_column_stats(
    file_id: str,
    col_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    node = await _load_file(db, file_id, user, "viewer")
    return await dataset_service.column_stats(node, col_id)


@router.get("/{file_id}/raw")
async def get_dataset_raw(
    file_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The original uploaded file, for re-parsing with new options."""
    node = await _load_file(db, file_id, user, "viewer")
    if not node.raw_sha or not blob_store.exists(node.raw_sha):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No raw file")
    data = await blob_store.read_bytes(node.raw_sha)
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"x-file-name": node.raw_file_name or "data"},
    )


@router.put("/{file_id}/data", status_code=status.HTTP_204_NO_CONTENT)
async def put_dataset_data(
    file_id: str,
    body: DatasetDataWrite,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    node = await _load_file(db, file_id, user, "editor")
    await dataset_service.write_rows(db, node, body.rows)


# Analyses moved to the disk-source dataset-files router (keyed by dataset path).
