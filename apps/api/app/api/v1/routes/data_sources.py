from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_role
from app.models.data_source import DataSource
from app.models.user import User
from app.schemas.data_source import (
    DataSourceCreate,
    DataSourceFileImportRequest,
    DataSourceFileResponse,
    DataSourceResponse,
    DataSourceUpdate,
    IntrospectedTable,
    QueryRequest,
    QueryResult,
    TestConnectionRequest,
    TestConnectionResult,
)
from app.services import blob_store, data_source_service

router = APIRouter(prefix="/data-sources", tags=["data-sources"])


async def _require_source_access(
    db: AsyncSession, source: DataSource, user: User, min_role: str
) -> None:
    """Data source access derives from its workspace membership."""
    if source.workspace_id is not None:
        await check_workspace_role(db, source.workspace_id, user, min_role)


async def _load_source(
    db: AsyncSession, source_id: str, user: User, min_role: str
) -> DataSource:
    source = await data_source_service.get(db, source_id)
    if source is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _require_source_access(db, source, user, min_role)
    return source


@router.get("", response_model=list[DataSourceResponse])
async def list_data_sources(
    workspace_id: str | None = Query(default=None, alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if workspace_id is not None:
        await check_workspace_role(db, workspace_id, user, "viewer")
        return await data_source_service.list_for_workspace(db, workspace_id)
    # No workspace filter: return sources the user can see (admin sees all).
    sources = await data_source_service.list_all(db)
    visible: list[DataSource] = []
    for s in sources:
        if s.workspace_id is None:
            visible.append(s)
            continue
        try:
            await check_workspace_role(db, s.workspace_id, user, "viewer")
            visible.append(s)
        except HTTPException:
            continue
    return visible


@router.post("", response_model=DataSourceResponse, status_code=status.HTTP_201_CREATED)
async def create_data_source(
    body: DataSourceCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if body.workspace_id is not None:
        await check_workspace_role(db, body.workspace_id, user, "editor")
    return await data_source_service.create(db, body, user)


@router.post("/test-connection", response_model=TestConnectionResult)
async def test_connection(
    body: TestConnectionRequest,
    _user: User = Depends(get_current_user),
):
    """Open a live connection to an external database, introspect it, and return
    its tables. The password in the request is used for the test only and is
    never persisted."""
    ok, error, tables = await data_source_service.test_connection(body.connection_config)
    return TestConnectionResult(ok=ok, error=error, tables=tables)


# --- Files (declared before /{source_id} would shadow, but paths don't overlap) ---

@router.post(
    "/files/import",
    response_model=DataSourceFileResponse,
    status_code=status.HTTP_201_CREATED,
)
async def import_data_source_file(
    body: DataSourceFileImportRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_source(db, body.data_source_id, user, "editor")
    if not blob_store.exists(body.sha):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Uploaded file not found — the upload may not have completed.",
        )
    return await data_source_service.import_file(db, body)


@router.get("/files/{file_id}/blob")
async def get_data_source_file_blob(
    file_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The raw bytes of a file, for mounting into the browser DuckDB (front-only
    query path). Disappears once the server-side query engine lands (§03 step b)."""
    file = await data_source_service.get_file(db, file_id)
    if file is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _load_source(db, file.data_source_id, user, "viewer")
    if not blob_store.exists(file.content_hash):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Blob missing")
    data = await blob_store.read_bytes(file.content_hash)
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"x-file-name": file.file_name},
    )


@router.delete("/files/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_data_source_file(
    file_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    file = await data_source_service.get_file(db, file_id)
    if file is None:
        return
    await _load_source(db, file.data_source_id, user, "editor")
    await data_source_service.delete_file(db, file)


@router.get("/{source_id}", response_model=DataSourceResponse)
async def get_data_source(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load_source(db, source_id, user, "viewer")


@router.patch("/{source_id}", response_model=DataSourceResponse)
async def update_data_source(
    source_id: str,
    body: DataSourceUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    source = await _load_source(db, source_id, user, "editor")
    return await data_source_service.update(db, source, body)


@router.delete("/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_data_source(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    source = await _load_source(db, source_id, user, "editor")
    await data_source_service.delete(db, source)


@router.post("/{source_id}/query", response_model=QueryResult)
async def query_data_source(
    source_id: str,
    body: QueryRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Run read-only SQL server-side against an external source (Postgres) and
    return the result rows. The server-mode counterpart to the browser's
    queryDataSource — the raw tables never reach the client, only results."""
    source = await _load_source(db, source_id, user, "viewer")
    try:
        rows = await data_source_service.query(db, source, body.sql)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    except Exception as e:  # noqa: BLE001 — surface SQL/connection errors to the client
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
    return QueryResult(rows=rows)


@router.post("/{source_id}/retest", response_model=TestConnectionResult)
async def retest_data_source(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Re-validate a stored external source using its saved (encrypted)
    credentials — no password from the client. Returns ok + introspected tables
    so the UI can refresh status and stats."""
    source = await _load_source(db, source_id, user, "editor")
    ok, error, tables = await data_source_service.test_connection_stored(source)
    return TestConnectionResult(ok=ok, error=error, tables=tables)


@router.get("/{source_id}/schema", response_model=list[IntrospectedTable])
async def get_data_source_schema(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Introspected tables + columns of an external source, for the schema
    mapping / table-discovery UI. Uses the stored (encrypted) credentials."""
    source = await _load_source(db, source_id, user, "viewer")
    return await data_source_service.introspect(db, source)


@router.get("/{source_id}/files", response_model=list[DataSourceFileResponse])
async def list_data_source_files(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_source(db, source_id, user, "viewer")
    return await data_source_service.list_files(db, source_id)
