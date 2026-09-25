"""Dataset files — projects/<uid>/datasets/ on disk is the single source of truth.
Raw files (CSV/XLSX/Parquet) are scanned from disk; a derived Parquet cache powers
pagination and column stats. Analyses (Lot 2) reconcile against this scan."""

import asyncio
import csv
import io

import duckdb
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_project_permission
from app.models.project import Project
from app.models.user import User
from app.schemas.dataset import (
    DatasetAnalysisCreate,
    DatasetAnalysisResponse,
    DatasetAnalysisUpdate,
    DatasetRowsPage,
    DatasetRowsQuery,
)
from app.schemas.dataset_fs import (
    DsColumnMeta,
    DsCreateEmpty,
    DsCreateFolder,
    DsDelete,
    DsDuplicate,
    DsFromQuery,
    DsImport,
    DsMove,
    DsNodeResponse,
    DsOps,
    DsOpsResponse,
    DsPreview,
    DsPreviewPath,
    DsPreviewResponse,
    DsReimport,
)
from app.core.permissions import check_workspace_permission
from app.models.data_source import DataSource
from app.services import blob_store, data_source_service, database_credential_service, dataset_service, notification_service, project_fs
from app.services.data import dataset_fs, dataset_parser, dataset_rows, file_reader

router = APIRouter(prefix="/dataset-files", tags=["dataset-files"])


async def _check_project(db: AsyncSession, project_uid: str, user: User, permission: str) -> None:
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    await check_project_permission(db, project, user, permission)
    # Cache the path bindings so the sync scan/dir helpers resolve datasets_path.
    project_fs.prime_binding(project_uid, project.ide_path, project.scripts_path, project.datasets_path)


@router.get("", response_model=list[DsNodeResponse])
async def list_dataset_files(
    project_uid: str = Query(alias="projectUid"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Scan datasets/ from disk (names + tree only — no columns/rowCount). Those
    meta are resolved lazily per file via /meta when a file is opened, so the list
    stays instant regardless of how many/how large the datasets are (parsing a big
    CSV or a multi-GB parquet on every list would freeze the event loop). Purges
    cache entries + reconciles analyses whose raw file disappeared."""
    await _check_project(db, project_uid, user, "datasets:read")
    dataset_fs.purge_orphans(project_uid)
    await dataset_service.reconcile_analyses(db, project_uid)
    return [
        DsNodeResponse(
            id=n["id"], name=n["name"], type=n["type"], parent_id=n["parentId"],
            path=n["path"], columns=None, row_count=None,
        )
        for n in project_fs.scan_datasets(project_uid)
    ]


@router.get("/meta", response_model=DsNodeResponse)
async def dataset_meta(
    project_uid: str = Query(alias="projectUid"),
    path: str = Query(),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Columns + rowCount for one dataset file, resolved on demand (the lazy
    counterpart to the meta-free listing). Parsing runs in a worker thread so a
    large file never blocks the event loop. An unparseable file still returns a
    node, without meta."""
    await _check_project(db, project_uid, user, "datasets:read")
    if not project_fs.dataset_path(project_uid, path).is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dataset not found")
    # Off the event loop: a big CSV's first open rebuilds the Parquet cache.
    return await asyncio.to_thread(_file_node, project_uid, path)


async def _resolve_file(db: AsyncSession, project_uid: str, path: str, user: User, permission: str) -> dict:
    await _check_project(db, project_uid, user, permission)
    try:
        # resolve_cache parses on a cache miss (a big CSV's first open rebuilds the
        # Parquet cache) — run it off the event loop so it never freezes the server.
        return await asyncio.to_thread(dataset_fs.resolve_cache, project_uid, path)
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
    res = await _resolve_file(db, project_uid, path, user, "datasets:read")
    col_types = {c["id"]: c["type"] for c in res["columns"]}
    # by_alias=True so keys are camelCase (colId/from/values) — the exact keys
    # _build_where reads; a snake_case dump would silently no-op every filter.
    filters = [f.model_dump(by_alias=True) for f in body.filters]
    na = [n.model_dump(by_alias=True) for n in body.na]
    sort = body.sort.model_dump(by_alias=True) if body.sort else None
    # A native parquet is read in place with its real column names; pass columns
    # so the query aliases them to the col_<slug> ids the filters/sort speak.
    native_columns = res["columns"] if res.get("native") else None
    rows, total = dataset_rows.query_page(
        res["parquet"], col_types, offset=body.offset, limit=body.limit,
        sort=sort, filters=filters, na=na, columns=native_columns,
    )
    return DatasetRowsPage(rows=rows, total=total)


@router.get("/columns/{col_id}/stats")
async def column_stats(
    col_id: str,
    project_uid: str = Query(alias="projectUid"),
    path: str = Query(),
    full: bool = Query(False),  # lift the top-20 category cap (panel "show all")
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    res = await _resolve_file(db, project_uid, path, user, "datasets:read")
    col = next((c for c in res["columns"] if c["id"] == col_id), None)
    if col is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Column not found")
    native_columns = res["columns"] if res.get("native") else None
    return dataset_rows.column_stats(res["parquet"], col_id, col["type"], columns=native_columns, full=full)


@router.get("/columns/{col_id}/distinct")
async def column_distinct(
    col_id: str,
    project_uid: str = Query(alias="projectUid"),
    path: str = Query(),
    limit: int = Query(1000, ge=1, le=1000),
    search: str | None = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Distinct values of a column, for a filter dropdown. Unlike /stats (top-20
    by frequency), lists values alphabetically up to `limit` with optional search."""
    res = await _resolve_file(db, project_uid, path, user, "datasets:read")
    col = next((c for c in res["columns"] if c["id"] == col_id), None)
    if col is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Column not found")
    native_columns = res["columns"] if res.get("native") else None
    return dataset_rows.distinct_values(res["parquet"], col_id, limit=limit, search=search, columns=native_columns)


@router.get("/raw")
async def get_raw(
    project_uid: str = Query(alias="projectUid"),
    path: str = Query(),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Download the raw dataset file from disk (datasets/<path>)."""
    from fastapi.responses import FileResponse

    await _check_project(db, project_uid, user, "datasets:read")
    try:
        p = project_fs.dataset_path(project_uid, path)
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid path")
    if not p.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    name = path.rsplit("/", 1)[-1]
    return FileResponse(p, filename=name, headers={"x-file-name": name})


@router.post("/preview", response_model=DsPreviewResponse)
async def preview_dataset(
    body: DsPreview,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Parse an already-uploaded blob for the import dialog's preview, WITHOUT
    persisting it — same server parser (columns, types over the whole file, row
    count, Excel sheet names) the eventual import uses, so what the user previews
    is exactly what gets imported. In server mode this replaces the browser
    (papaparse/xlsx) parse entirely."""
    await _check_project(db, body.project_uid, user, "datasets:write")
    if not blob_store.exists(body.sha):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Uploaded file not found")
    path = blob_store.path_for(body.sha)
    try:
        result = await asyncio.to_thread(
            dataset_parser.preview_blob, path, body.file_name, body.parse_options
        )
    except file_reader.ExcelSupportUnavailable:
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "excel_support_unavailable")
    except (ValueError, RuntimeError, duckdb.Error) as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Preview failed: {e}")
    return DsPreviewResponse(
        columns=result["columns"],
        preview=result["preview"],
        row_count=result["rowCount"],
        sheet_names=result.get("sheetNames"),
    )


@router.post("/preview-path", response_model=DsPreviewResponse)
async def preview_dataset_path(
    body: DsPreviewPath,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Preview an already-imported dataset re-parsed with new options, WITHOUT
    persisting — the Import Settings dialog's server-mode counterpart, so the
    user sees the effect of changed options before committing a reimport."""
    await _check_project(db, body.project_uid, user, "datasets:write")
    try:
        raw = project_fs.dataset_path(body.project_uid, body.path)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    if not raw.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dataset not found")
    try:
        result = await asyncio.to_thread(
            dataset_parser.preview_blob, raw, raw.name, body.parse_options
        )
    except file_reader.ExcelSupportUnavailable:
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "excel_support_unavailable")
    except (ValueError, RuntimeError, duckdb.Error) as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Preview failed: {e}")
    return DsPreviewResponse(
        columns=result["columns"],
        preview=result["preview"],
        row_count=result["rowCount"],
        sheet_names=result.get("sheetNames"),
    )


@router.post("/import", response_model=DsNodeResponse, status_code=status.HTTP_201_CREATED)
async def import_dataset(
    body: DsImport,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Land an uploaded raw file into datasets/<path> on disk (the source of truth),
    then parse it into the Parquet cache and return the node with columns/rowCount."""
    await _check_project(db, body.project_uid, user, "datasets:write")
    if not blob_store.exists(body.sha):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Uploaded file not found")
    try:
        dst = project_fs.dataset_path(body.project_uid, body.path)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    dst.parent.mkdir(parents=True, exist_ok=True)
    import shutil

    shutil.copyfile(blob_store.path_for(body.sha), dst)
    try:
        res = dataset_fs.resolve_cache(body.project_uid, body.path, body.parse_options)
        columns, row_count = res["columns"], res["rowCount"]
    except file_reader.ExcelSupportUnavailable:
        dst.unlink(missing_ok=True)
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "excel_support_unavailable")
    except (ValueError, RuntimeError, duckdb.Error) as e:
        # The preview parsed this same blob server-side, so a failure here is
        # unexpected — surface it instead of landing a phantom column-less
        # dataset. Roll back the file we just copied so a retry starts clean.
        dst.unlink(missing_ok=True)
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Import failed: {e}")
    return DsNodeResponse(
        id=project_fs.node_id("ds", body.path),
        name=body.path.rsplit("/", 1)[-1], type="file",
        parent_id=(project_fs.node_id("ds", body.path.rsplit("/", 1)[0]) if "/" in body.path else None),
        path=body.path, columns=columns, row_count=row_count,
    )


@router.post("/create-empty", response_model=DsNodeResponse, status_code=status.HTTP_201_CREATED)
async def create_empty_dataset(
    body: DsCreateEmpty,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create an empty dataset on disk from a column list.

    A manual collection has no file to upload — it starts empty and fills row by
    row — but it must still be a real file on disk, or it would exist only in the
    client's memory and vanish on reload. So a CSV holding just the header is
    written, and everything downstream (parse, cache, ops, export) treats it like
    any other dataset."""
    await _check_project(db, body.project_uid, user, "datasets:write")
    try:
        dst = project_fs.dataset_path(body.project_uid, body.path)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    if dst.exists():
        raise HTTPException(status.HTTP_409_CONFLICT, "A dataset already exists at this path")

    names = [str(c.get("name") or c.get("id") or "") for c in body.columns]
    if not any(names):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "At least one named column is required")

    dst.parent.mkdir(parents=True, exist_ok=True)
    # csv module rather than ",".join: a column named `a,b` or holding a quote
    # would otherwise produce a header that reparses into different columns.
    buf = io.StringIO()
    csv.writer(buf, lineterminator="\n").writerow(names)
    dst.write_text(buf.getvalue(), encoding="utf-8")

    # Persist the requested types as parse-option overrides. The file holds a header
    # and no rows, so inference has nothing to work from and would type every column
    # "unknown" — here the caller knows (an id column is a number), and these
    # overrides survive every later reparse.
    types = {
        str(c["id"]): str(c["type"])
        for c in body.columns
        if c.get("id") and c.get("type") and c.get("type") != "unknown"
    }
    if types:
        dataset_fs.write_parse_options(body.project_uid, body.path, {"columnTypes": types})

    try:
        dataset_fs.resolve_cache(body.project_uid, body.path)
    except (ValueError, RuntimeError, duckdb.Error) as e:
        dst.unlink(missing_ok=True)
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Create failed: {e}")
    return _file_node(body.project_uid, body.path)


@router.post("/from-query", response_model=DsNodeResponse, status_code=status.HTTP_201_CREATED)
async def create_dataset_from_query(
    body: DsFromQuery,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Run a read-only query on one of the project's databases and write its full
    result to datasets/<path> as Parquet (no row cap, unlike /query)."""
    await _check_project(db, body.project_uid, user, "datasets:write")
    project = await db.get(Project, body.project_uid)
    if body.data_source_id not in (project.linked_data_source_ids or []):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This database is not linked to the project")
    source = await db.get(DataSource, body.data_source_id)
    if source is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Database not found")
    if source.workspace_id is not None:
        await check_workspace_permission(db, source.workspace_id, user, "databases:read")

    path = body.path if body.path.lower().endswith(".parquet") else f"{body.path}.parquet"
    try:
        dst = project_fs.dataset_path(body.project_uid, path)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    existed = dst.exists()
    if existed and not body.replace:
        raise HTTPException(status.HTTP_409_CONFLICT, "A dataset already exists at this path")

    login = await database_credential_service.resolve_login(db, source, user.id)
    try:
        table = await data_source_service.query(db, source, login, body.sql, arrow=True)
    except Exception as e:  # noqa: BLE001 — surface SQL errors to the caller
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))

    import pyarrow.parquet as pq

    dst.parent.mkdir(parents=True, exist_ok=True)
    # Written aside then renamed, so a reader never sees half a file.
    tmp = dst.with_name(f".{dst.name}.tmp")
    await asyncio.to_thread(pq.write_table, table, tmp)
    tmp.replace(dst)
    node = await asyncio.to_thread(_file_node, body.project_uid, path)
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request),
        action="updated" if existed else "created", entity_type="dataset", entity_id=path,
        project_uid=body.project_uid, label=path,
        # A replaced file is gone once overwritten: only a creation is undoable.
        undo=None if existed else {"kind": "dataset", "op": "delete", "id": path},
    )
    return node


async def _notify_dataset(
    db: AsyncSession, request: Request, user: User, action: str, project_uid: str, path: str,
) -> None:
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request), action=action,
        entity_type="dataset", entity_id=path, project_uid=project_uid, label=path,
    )


def _file_node(project_uid: str, path: str) -> DsNodeResponse:
    columns = row_count = parse_options = None
    try:
        res = dataset_fs.resolve_cache(project_uid, path)
        columns, row_count, parse_options = res["columns"], res["rowCount"], res.get("parseOptions")
    except Exception:
        pass
    # The log travels on the node: the client addresses rows by ordinal, and
    # minting the next one means knowing which are already taken.
    ops = dataset_fs.read_ops(project_uid, path) or None
    return DsNodeResponse(
        id=project_fs.node_id("ds", path),
        name=path.rsplit("/", 1)[-1], type="file",
        parent_id=(project_fs.node_id("ds", path.rsplit("/", 1)[0]) if "/" in path else None),
        path=path, columns=columns, row_count=row_count, parse_options=parse_options, ops=ops,
    )


@router.post("/reimport", response_model=DsNodeResponse)
async def reimport_dataset(
    body: DsReimport,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Re-parse the raw file with new options (rebuilds the Parquet cache)."""
    await _check_project(db, body.project_uid, user, "datasets:write")
    try:
        dataset_fs.resolve_cache(body.project_uid, body.path, body.parse_options, force=True)
    except FileNotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dataset not found")
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    return _file_node(body.project_uid, body.path)


@router.post("/columns/meta", response_model=DsNodeResponse)
async def set_column_meta(
    body: DsColumnMeta,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Persist editorial column metadata (label/description/valueLabels) to the
    disk sidecar. Metadata-only — never touches the raw file or Parquet cache; the
    returned node re-merges it onto the derived columns."""
    await _check_project(db, body.project_uid, user, "datasets:write")
    if not project_fs.dataset_path(body.project_uid, body.path).is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dataset not found")
    if body.columns is not None:
        dataset_fs.write_column_meta(body.project_uid, body.path, body.columns)
    if body.parse_options is not None:
        # Field-wise merge so setting one option (e.g. columnFilterMode) never wipes
        # another already stored (e.g. columnTypes).
        merged = {**(dataset_fs.read_parse_options(body.project_uid, body.path) or {}), **body.parse_options}
        dataset_fs.write_parse_options(body.project_uid, body.path, merged)
    await _notify_dataset(db, request, user, "updated", body.project_uid, body.path)
    return _file_node(body.project_uid, body.path)


@router.post("/ops", response_model=DsOpsResponse)
async def record_ops(
    body: DsOps,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Record edit operations against a dataset and rebuild its Parquet cache.

    The raw file is never written to: the log is persisted in the sidecar and the
    cache is re-derived as raw -> parse -> replay(ops). Appends by default so
    concurrent editors don't clobber each other; `replace` rewrites the log, which
    is what compaction and a reset-to-raw need."""
    await _check_project(db, body.project_uid, user, "datasets:write")
    if not project_fs.dataset_path(body.project_uid, body.path).is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dataset not found")

    if body.replace:
        ops = dataset_fs.write_ops(body.project_uid, body.path, body.ops)
    else:
        ops = dataset_fs.append_ops(body.project_uid, body.path, body.ops)
    # Rebuild off-thread: replay materialises every row, so it must not block the
    # event loop on a large dataset.
    await asyncio.to_thread(dataset_fs.resolve_cache, body.project_uid, body.path)
    await _notify_dataset(db, request, user, "updated", body.project_uid, body.path)
    return DsOpsResponse(node=_file_node(body.project_uid, body.path), ops=ops)


@router.post("/duplicate", response_model=DsNodeResponse, status_code=status.HTTP_201_CREATED)
async def duplicate_dataset(
    body: DsDuplicate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Copy the raw dataset file to a sibling with a new name."""
    await _check_project(db, body.project_uid, user, "datasets:write")
    import shutil

    try:
        src = project_fs.dataset_path(body.project_uid, body.path)
        parent = body.path.rsplit("/", 1)[0] if "/" in body.path else ""
        new_path = f"{parent}/{body.new_name}" if parent else body.new_name
        dst = project_fs.dataset_path(body.project_uid, new_path)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    if not src.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dataset not found")
    shutil.copyfile(src, dst)
    await _notify_dataset(db, request, user, "created", body.project_uid, new_path)
    return _file_node(body.project_uid, new_path)


@router.post("/folder", response_model=DsNodeResponse, status_code=status.HTTP_201_CREATED)
async def create_folder(
    body: DsCreateFolder,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _check_project(db, body.project_uid, user, "datasets:write")
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
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _check_project(db, body.project_uid, user, "datasets:write")
    try:
        src = project_fs.dataset_path(body.project_uid, body.path)
        dst = project_fs.dataset_path(body.project_uid, body.new_path)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    if src.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.replace(dst)
        await _notify_dataset(db, request, user, "updated", body.project_uid, body.new_path)


@router.post("/delete", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dataset(
    body: DsDelete,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _check_project(db, body.project_uid, user, "datasets:delete")
    import shutil

    try:
        p = project_fs.dataset_path(body.project_uid, body.path)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    if p.is_dir():
        shutil.rmtree(p, ignore_errors=True)
    elif p.is_file():
        p.unlink(missing_ok=True)
    await _notify_dataset(db, request, user, "deleted", body.project_uid, body.path)
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
    await _check_project(db, project_uid, user, "datasets:read")
    return await dataset_service.list_analyses(db, project_uid, path)


@router.post("/analyses", response_model=DatasetAnalysisResponse, status_code=status.HTTP_201_CREATED)
async def create_analysis(
    body: DatasetAnalysisCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _check_project(db, body.project_uid, user, "datasets:write")
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
    await _check_project(db, a.project_uid, user, "datasets:write")
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
    await _check_project(db, a.project_uid, user, "datasets:delete")
    await dataset_service.delete_analysis(db, a)
