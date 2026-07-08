"""Dataset files — projects/<uid>/datasets/ on disk is the single source of truth.
Raw files (CSV/XLSX/Parquet) are scanned from disk; a derived Parquet cache powers
pagination and column stats. Analyses (Lot 2) reconcile against this scan."""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_role
from app.models.project import Project
from app.models.user import User
from app.schemas.dataset import (
    DatasetAnalysisCreate,
    DatasetAnalysisResponse,
    DatasetAnalysisUpdate,
    DatasetRowsPage,
    DatasetRowsQuery,
)
from app.schemas.dataset_fs import DsCreateFolder, DsDelete, DsMove, DsNodeResponse
from app.services import dataset_service, project_fs
from app.services.data import dataset_fs, dataset_rows

router = APIRouter(prefix="/dataset-files", tags=["dataset-files"])


async def _check_project(db: AsyncSession, project_uid: str, user: User, min_role: str) -> None:
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    if project.workspace_id is not None:
        await check_workspace_role(db, project.workspace_id, user, min_role)


def _resolve_meta(project_uid: str, node: dict) -> tuple[list[dict] | None, int | None]:
    """Parse (or reuse cache) to expose columns + rowCount for a file node."""
    if node["type"] != "file":
        return None, None
    try:
        res = dataset_fs.resolve_cache(project_uid, node["path"])
        return res["columns"], res["rowCount"]
    except Exception:
        # Unparseable file (e.g. a non-tabular drop-in) still lists, without meta.
        return None, None


@router.get("", response_model=list[DsNodeResponse])
async def list_dataset_files(
    project_uid: str = Query(alias="projectUid"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Scan datasets/ from disk. Purges cache entries + reconciles analyses whose
    raw dataset file disappeared (covers files removed outside the app + Refresh)."""
    await _check_project(db, project_uid, user, "viewer")
    dataset_fs.purge_orphans(project_uid)
    await dataset_service.reconcile_analyses(db, project_uid)
    out: list[DsNodeResponse] = []
    for n in project_fs.scan_datasets(project_uid):
        columns, row_count = _resolve_meta(project_uid, n)
        out.append(DsNodeResponse(
            id=n["id"], name=n["name"], type=n["type"], parent_id=n["parentId"],
            path=n["path"], columns=columns, row_count=row_count,
        ))
    return out


async def _resolve_file(db: AsyncSession, project_uid: str, path: str, user: User, min_role: str) -> dict:
    await _check_project(db, project_uid, user, min_role)
    try:
        return dataset_fs.resolve_cache(project_uid, path)
    except FileNotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dataset not found")


@router.post("/rows/query", response_model=DatasetRowsPage)
async def query_rows(
    body: DatasetRowsQuery,
    project_uid: str = Query(alias="projectUid"),
    path: str = Query(),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    res = await _resolve_file(db, project_uid, path, user, "viewer")
    col_types = {c["id"]: c["type"] for c in res["columns"]}
    filters = [f.model_dump(by_alias=False) for f in body.filters]
    na = [n.model_dump(by_alias=False) for n in body.na]
    sort = body.sort.model_dump(by_alias=False) if body.sort else None
    rows, total = dataset_rows.query_page(
        res["parquet"], col_types, offset=body.offset, limit=body.limit,
        sort=sort, filters=filters, na=na,
    )
    return DatasetRowsPage(rows=rows, total=total)


@router.get("/columns/{col_id}/stats")
async def column_stats(
    col_id: str,
    project_uid: str = Query(alias="projectUid"),
    path: str = Query(),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    res = await _resolve_file(db, project_uid, path, user, "viewer")
    col = next((c for c in res["columns"] if c["id"] == col_id), None)
    if col is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Column not found")
    return dataset_rows.column_stats(res["parquet"], col_id, col["type"])


@router.post("/folder", response_model=DsNodeResponse, status_code=status.HTTP_201_CREATED)
async def create_folder(
    body: DsCreateFolder,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _check_project(db, body.project_uid, user, "editor")
    try:
        project_fs.dataset_path(body.project_uid, body.path).mkdir(parents=True, exist_ok=True)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    return DsNodeResponse(
        id=project_fs.node_id("ds", body.path),
        name=body.path.rsplit("/", 1)[-1], type="folder",
        parent_id=(project_fs.node_id("ds", body.path.rsplit("/", 1)[0]) if "/" in body.path else None),
        path=body.path,
    )


@router.post("/move", status_code=status.HTTP_204_NO_CONTENT)
async def move_dataset(
    body: DsMove,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _check_project(db, body.project_uid, user, "editor")
    try:
        src = project_fs.dataset_path(body.project_uid, body.path)
        dst = project_fs.dataset_path(body.project_uid, body.new_path)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    if src.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.replace(dst)


@router.post("/delete", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dataset(
    body: DsDelete,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _check_project(db, body.project_uid, user, "editor")
    import shutil

    try:
        p = project_fs.dataset_path(body.project_uid, body.path)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    if p.is_dir():
        shutil.rmtree(p, ignore_errors=True)
    elif p.is_file():
        p.unlink(missing_ok=True)
    dataset_fs.purge_orphans(body.project_uid)
    await dataset_service.reconcile_analyses(db, body.project_uid)


# --- Analyses (keyed by dataset path) --------------------------------------

@router.get("/analyses", response_model=list[DatasetAnalysisResponse])
async def list_analyses(
    project_uid: str = Query(alias="projectUid"),
    path: str = Query(),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _check_project(db, project_uid, user, "viewer")
    return await dataset_service.list_analyses(db, project_uid, path)


@router.post("/analyses", response_model=DatasetAnalysisResponse, status_code=status.HTTP_201_CREATED)
async def create_analysis(
    body: DatasetAnalysisCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _check_project(db, body.project_uid, user, "editor")
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
    await _check_project(db, a.project_uid, user, "editor")
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
    await _check_project(db, a.project_uid, user, "editor")
    await dataset_service.delete_analysis(db, a)
