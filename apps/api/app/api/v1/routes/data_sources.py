import asyncio
import contextlib
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, status
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.websockets import WebSocketDisconnect

from app.core.database import async_session, get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
from app.core.ws_auth import authenticate_ws
from app.models.data_source import DataSource
from app.models.user import User
from app.schemas.concept_cache import (
    ConceptCacheRefreshRequest,
    ConceptCacheStatus,
    ConceptPageRequest,
    ConceptPageResult,
    ConceptStatsResponse,
    ConceptStatsSave,
)
from app.schemas.data_source import (
    DatabaseConnectionInfo,
    CreateFromDdlRequest,
    DataSourceCreate,
    DataSourceFileImportRequest,
    DataSourceFileResponse,
    DataSourceResponse,
    DataSourceUpdate,
    EtlRunRequest,
    IntrospectedTable,
    ParquetTablePath,
    QueryRequest,
    QueryResult,
    TestConnectionRequest,
    TestConnectionResult,
)
from app.schemas.stats_cache import StatsCacheResponse, StatsCacheSave
from app.services import (
    blob_store,
    concept_stats_cache_service,
    data_source_service,
    stats_cache_service,
)
from app.services.data import concept_cache_fs, db_connect, managed_db

router = APIRouter(prefix="/data-sources", tags=["data-sources"])


async def _require_source_access(
    db: AsyncSession, source: DataSource, user: User, permission: str
) -> None:
    """Data source access derives from its workspace membership."""
    if source.workspace_id is not None:
        await check_workspace_permission(db, source.workspace_id, user, permission)


async def _load_source(
    db: AsyncSession, source_id: str, user: User, permission: str
) -> DataSource:
    source = await data_source_service.get(db, source_id)
    if source is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _require_source_access(db, source, user, permission)
    return source


@router.get("", response_model=list[DataSourceResponse])
async def list_data_sources(
    workspace_id: str | None = Query(default=None, alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if workspace_id is not None:
        await check_workspace_permission(db, workspace_id, user, "databases:read")
        return await data_source_service.list_for_workspace(db, workspace_id)
    # No workspace filter: return sources the user can see (admin sees all).
    sources = await data_source_service.list_all(db)
    visible: list[DataSource] = []
    for s in sources:
        if s.workspace_id is None:
            visible.append(s)
            continue
        try:
            await check_workspace_permission(db, s.workspace_id, user, "databases:read")
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
        await check_workspace_permission(db, body.workspace_id, user, "databases:write")
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
    await _load_source(db, body.data_source_id, user, "databases:write")
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
    await _load_source(db, file.data_source_id, user, "databases:read")
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
    await _load_source(db, file.data_source_id, user, "databases:delete")
    await data_source_service.delete_file(db, file)


@router.get("/{source_id}", response_model=DataSourceResponse)
async def get_data_source(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load_source(db, source_id, user, "databases:read")


@router.patch("/{source_id}", response_model=DataSourceResponse)
async def update_data_source(
    source_id: str,
    body: DataSourceUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    source = await _load_source(db, source_id, user, "databases:write")
    return await data_source_service.update(db, source, body)


@router.delete("/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_data_source(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    source = await _load_source(db, source_id, user, "databases:delete")
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
    source = await _load_source(db, source_id, user, "databases:read")
    try:
        rows = await data_source_service.query(db, source, body.sql)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    except Exception as e:  # noqa: BLE001 — surface SQL/connection errors to the client
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
    return QueryResult(rows=rows)


@router.post("/{source_id}/create-from-ddl", response_model=DataSourceResponse)
async def create_from_ddl(
    source_id: str,
    body: CreateFromDdlRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Materialise a server-owned DuckDB file for this source and apply the DDL.

    The browser builds the same schema in its own WASM database; in server mode
    the tables must exist on disk, or every later query hits an empty catalog."""
    source = await _load_source(db, source_id, user, "databases:write")
    try:
        await asyncio.to_thread(managed_db.create_from_ddl, source.id, body.ddl)
    except Exception as e:  # noqa: BLE001 — a bad DDL is a client error
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
    config = dict(source.connection_config or {})
    config["managed"] = True
    config.pop("inMemory", None)
    return await data_source_service.update(
        db, source, DataSourceUpdate(connection_config=config)
    )


@router.post("/{source_id}/etl-run", response_model=QueryResult)
async def etl_run(
    source_id: str,
    body: EtlRunRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Run ETL SQL: this source is the writable target, `roles` the databases
    attached read-only alongside it so one statement can span several."""
    target = await _load_source(db, source_id, user, "databases:write")
    roles: dict[str, DataSource] = {}
    for role, ds_id in (body.roles or {}).items():
        if role == "target" or not ds_id:
            continue
        roles[role] = await _load_source(db, ds_id, user, "databases:read")
    try:
        rows = await data_source_service.run_etl(
            db, target, body.sql, roles, body.mapping_data
        )
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    except db_connect.EtlRunCancelled:
        # The client that asked for this run is gone (reload/navigation), so there
        # is nobody to answer. Not an error: re-raised as a cancellation so it is
        # not reported as a failed script.
        raise
    except Exception as e:  # noqa: BLE001 — surface SQL errors to the client
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
    return QueryResult(rows=rows)


@router.websocket("/{source_id}/etl-run-stream")
async def etl_run_stream(websocket: WebSocket, source_id: str):
    """Run one ETL script on ONE connection, streaming per-statement progress.

    The HTTP twin above takes a single statement, so a script split by the client
    got a fresh connection per statement and lost everything session-scoped:
    `SET VARIABLE` set in one statement was gone by the next, and
    `query(getvariable(...))` then failed with `syntax error at or near "NULL"`.

    Here the script arrives whole, the server splits it (the same splitter the
    client uses) and reports each statement as it starts — so progress stays live
    without paying for it in lost session state.

    Auth via ?token= (a WebSocket carries no Authorization header).
    """
    user = await authenticate_ws(websocket)
    if user is None:
        return  # authenticate_ws already closed with WS_AUTH_FAILED

    try:
        async with async_session() as db:
            target = await _load_source(db, source_id, user, "databases:write")
    except HTTPException:
        # Unknown source or no permission — the client asked for something it may
        # not have, which is a policy violation.
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    except Exception:
        # Anything else is our fault, not the client's; say so rather than
        # reporting a server fault as a permission denial.
        await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        return

    await websocket.accept()
    loop = asyncio.get_running_loop()

    try:
        msg = await websocket.receive_json()
    except (WebSocketDisconnect, ValueError):
        return  # client went away, or sent something that is not JSON

    sql = msg.get("sql")
    if not isinstance(sql, str):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    try:
        async with async_session() as db:
            roles: dict[str, DataSource] = {}
            for role, ds_id in (msg.get("roles") or {}).items():
                if role == "target" or not ds_id:
                    continue
                roles[role] = await _load_source(db, ds_id, user, "databases:read")
    except HTTPException:  # a role that does not exist, or one the user may not read
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    except Exception:
        await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        return

    # Called from the DuckDB worker thread, so the send is marshalled back onto
    # the loop rather than awaited here. Fire-and-forget: a progress event that
    # loses the race with a closing socket must not break the run.
    def on_statement(index: int, total: int, stmt: str) -> None:
        def send() -> None:
            asyncio.ensure_future(_send_quietly(websocket, {
                "type": "statement", "index": index, "total": total,
                "sql": stmt[:2000],
            }))
        loop.call_soon_threadsafe(send)

    async def run() -> None:
        async with async_session() as db:
            rows = await data_source_service.run_etl(
                db, target, sql, roles, msg.get("mappingData") or {},
                on_statement=on_statement,
            )
        await _send_quietly(websocket, {"type": "done", "rows": rows})

    task = asyncio.create_task(run())
    # The client stops a run by CLOSING the socket, so watch for that alongside
    # the run itself rather than waiting on the run alone.
    closed = asyncio.create_task(websocket.receive_text())
    try:
        done, _ = await asyncio.wait(
            {task, closed}, return_when=asyncio.FIRST_COMPLETED,
        )
        # `.exception()` itself raises if the task was cancelled, so only ask a
        # task that finished on its own.
        if task in done and not task.cancelled():
            exc = task.exception()
            # A cancelled run is the user pressing Stop, not a failure to report.
            if exc is not None and not isinstance(exc, db_connect.EtlRunCancelled):
                await _send_quietly(websocket, {"type": "error", "message": str(exc)})
    finally:
        closed.cancel()
        if not task.done():
            # Cancelling is what stops the run: run_etl shields the worker thread
            # and, on CancelledError, interrupts the statement and waits for the
            # file to be released. Abandoning the await instead would leave the
            # thread holding the target ATTACHed (see EtlRunHandle).
            task.cancel()
            with contextlib.suppress(BaseException):
                await task
        with contextlib.suppress(BaseException):
            await websocket.close()


async def _send_quietly(websocket: WebSocket, payload: dict) -> None:
    """Send, tolerating an already-closed socket: a run that finishes just after
    the client navigated away must unwind normally, not raise."""
    with contextlib.suppress(BaseException):
        await websocket.send_json(payload)


@router.post("/{source_id}/retest", response_model=TestConnectionResult)
async def retest_data_source(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Re-validate a stored external source using its saved (encrypted)
    credentials — no password from the client. Returns ok + introspected tables
    so the UI can refresh status and stats."""
    source = await _load_source(db, source_id, user, "databases:write")
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
    source = await _load_source(db, source_id, user, "databases:read")
    return await data_source_service.introspect(db, source)


@router.get("/{source_id}/connection-info", response_model=DatabaseConnectionInfo)
async def get_database_connection_info(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """How to reach this database from outside Linkr (R/Python, a SQL client).

    A file source answers with a path, a parquet source with its folder, an
    external engine with its host/port/database — never the password. Permission
    gated like any other read of the source, since it discloses server paths and
    connection details.
    """
    source = await _load_source(db, source_id, user, "databases:read")
    config = dict(source.connection_config or {})
    engine = config.get("engine")
    info = DatabaseConnectionInfo(engine=engine)

    if data_source_service.is_external_engine(engine):
        return DatabaseConnectionInfo(
            engine=engine,
            kind="external",
            host=config.get("host"),
            port=config.get("port"),
            database=config.get("database"),
            schema_name=config.get("schema"),
            username=config.get("username"),
        )

    if data_source_service.is_managed(source):
        path = managed_db.path_for(source.id)
        return DatabaseConnectionInfo(
            engine="duckdb", kind="file", path=str(path), exists=path.exists()
        )

    files = await data_source_service.list_files(db, source.id)
    if not files:
        return info

    paths = [blob_store.path_for(f.content_hash) for f in files]
    names = [f.file_name for f in files]
    # A Parquet source is addressed table by table, NOT by the directory holding
    # the blobs: that directory is the shared content-addressed store, so it mixes
    # in every other source's files and its entries have no .parquet suffix for a
    # glob to match. `path` is deliberately left unset.
    if len(files) > 1 or names[0].lower().endswith((".parquet", ".pq")):
        pairs = [(f.file_name, str(blob_store.path_for(f.content_hash))) for f in files]
        groups = data_source_service.parquet_table_paths(source, pairs)
        return DatabaseConnectionInfo(
            engine=engine,
            kind="parquet-folder",
            exists=all(p.is_file() for p in paths),
            blob=True,
            file_names=names,
            tables=[
                ParquetTablePath(
                    table=table,
                    paths=table_paths,
                    exists=all(Path(p).is_file() for p in table_paths),
                )
                for table, table_paths in sorted(groups.items())
            ],
        )

    return DatabaseConnectionInfo(
        engine=engine,
        kind="file",
        path=str(paths[0]),
        exists=paths[0].is_file(),
        # Content-addressed: the file is named by its sha, with no extension, so
        # a tool that keys off ".duckdb" needs telling.
        blob=True,
        file_names=names,
    )


@router.get("/{source_id}/concept-cache", response_model=ConceptCacheStatus)
async def concept_cache_status(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Whether the source has a materialized concept-list cache, and its "last
    refreshed" time (the Parquet file's mtime)."""
    await _load_source(db, source_id, user, "databases:read")
    return ConceptCacheStatus(
        exists=concept_cache_fs.exists(source_id),
        refreshed_at=concept_cache_fs.refreshed_at(source_id),
    )


@router.post("/{source_id}/concept-cache/refresh", response_model=ConceptCacheStatus)
async def refresh_concept_cache(
    source_id: str,
    body: ConceptCacheRefreshRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Materialize the concept list to Parquet (shared across users). Editor role,
    since it writes shared state. Atomic: readers keep seeing the old cache until
    the new one is in place."""
    source = await _load_source(db, source_id, user, "databases:write")
    try:
        mtime = await data_source_service.refresh_concept_cache(db, source, body.select_sql)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    except Exception as e:  # noqa: BLE001 — surface SQL/connection errors to the client
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
    return ConceptCacheStatus(exists=True, refreshed_at=mtime)


@router.post("/{source_id}/concept-cache/query", response_model=ConceptPageResult)
async def query_concept_cache(
    source_id: str,
    body: ConceptPageRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Run a page/filter/sort query against the cached concept Parquet (view
    `concepts`). 404 if the cache has not been built yet."""
    await _load_source(db, source_id, user, "databases:read")
    try:
        rows = await data_source_service.query_concept_cache(source_id, body.sql)
    except FileNotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No concept cache")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
    return ConceptPageResult(rows=rows)


@router.get(
    "/{source_id}/concept-stats/{concept_id}", response_model=ConceptStatsResponse
)
async def get_concept_stats(
    source_id: str,
    concept_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Shared cached detail-panel stats for one concept. 404 until first computed."""
    await _load_source(db, source_id, user, "databases:read")
    row = await concept_stats_cache_service.get(db, source_id, concept_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No stats")
    return row


@router.put(
    "/{source_id}/concept-stats/{concept_id}", response_model=ConceptStatsResponse
)
async def save_concept_stats(
    source_id: str,
    concept_id: int,
    body: ConceptStatsSave,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Persist the stats a client computed for one concept, sharing them."""
    await _load_source(db, source_id, user, "databases:write")
    return await concept_stats_cache_service.save(db, source_id, concept_id, body.stats)


_STATS_SCOPE = "database"


@router.get("/{source_id}/stats-cache", response_model=StatsCacheResponse | None)
async def get_database_stats_cache(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Shared, precomputed database statistics for this source (null if none).
    Stored server-side so every user of the project reuses one computed payload."""
    await _load_source(db, source_id, user, "databases:read")
    row = await stats_cache_service.get(db, _STATS_SCOPE, source_id)
    if row is None:
        return None
    return StatsCacheResponse(computed_at=row.computed_at, payload=row.payload)


@router.put("/{source_id}/stats-cache", response_model=StatsCacheResponse)
async def save_database_stats_cache(
    source_id: str,
    body: StatsCacheSave,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Store the statistics a client just computed, sharing them with the project."""
    await _load_source(db, source_id, user, "databases:write")
    row = await stats_cache_service.save(
        db, _STATS_SCOPE, source_id, body.computed_at, body.payload
    )
    return StatsCacheResponse(computed_at=row.computed_at, payload=row.payload)


@router.delete("/{source_id}/stats-cache", status_code=status.HTTP_204_NO_CONTENT)
async def delete_database_stats_cache(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Reset the shared statistics cache for this source (the "reset" button)."""
    # Cache reset is a recompute, not deleting the source → write, not delete.
    await _load_source(db, source_id, user, "databases:write")
    await stats_cache_service.delete(db, _STATS_SCOPE, source_id)


@router.get("/{source_id}/files", response_model=list[DataSourceFileResponse])
async def list_data_source_files(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_source(db, source_id, user, "databases:read")
    return await data_source_service.list_files(db, source_id)
