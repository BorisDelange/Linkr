import asyncio
import contextlib
import logging
import uuid

import duckdb
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import audit, deferred
from app.core.database import get_db
from app.core.deps import get_current_user, get_session_user
from app.core.permissions import check_workspace_permission
from app.core.redact import redact_secrets
from app.models.cohort import Cohort
from app.models.data_source import DataSource
from app.models.job import Job
from app.models.user import User
from app.schemas.concept_cache import (
    ConceptCacheAssembleRequest,
    ConceptCacheStatus,
    ConceptRunStart,
    ConceptUnitsJobRequest,
    ConceptPageRequest,
    ConceptPageResult,
    ConceptRelationsRequest,
    ConceptRelationsResult,
    ConceptStatsResponse,
    ConceptStatsSave,
)
from app.schemas.data_source import (
    CompactStatus,
    ParquetLayoutEntry,
    ParquetLayoutRequest,
    DatabaseConnectionInfo,
    CreateFromDdlRequest,
    MoveFileRequest,
    DataSourceCreate,
    DataSourceFileImportRequest,
    DataSourceFileResponse,
    DataSourceResponse,
    DataSourceUpdate,
    DatabaseLoginSave,
    DatabaseLoginStatus,
    DerivePlanRequest,
    DeriveRequest,
    FlightStatus,
    EtlJobRequest,
    EtlRunRequest,
    IntrospectedTable,
    QueryCancelRequest,
    QueryCancelResult,
    QueryJobRequest,
    QueryRequest,
    QueryExecution,
    QueryResult,
    TestConnectionRequest,
    TestConnectionResult,
)
from app.schemas.stats_cache import StatsCacheResponse, StatsCacheSave
from app.services import (
    blob_store,
    change_tracking,
    cohort_derive_service,
    concept_stats_cache_service,
    data_source_service,
    database_credential_service,
    fs_browser,
    notification_service,
    stats_cache_service,
)
from app.services.data import concept_cache_fs, etl_jobs, connection_pool, db_connect, managed_db, pushdown, query_cancel, query_jobs
from app.services.execution import jobs
from app.schemas.execution import JobResponse

logger = logging.getLogger(__name__)

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


async def _login(db: AsyncSession, source: DataSource, user: User):
    """The user's own login to `source` (None for a file database). Resolved
    before any `except Exception` that would turn the 428 into a 422."""
    return await database_credential_service.resolve_login(db, source, user.id)


def _principal(source: DataSource, user: User) -> str:
    return database_credential_service.principal_for(source, user.id)


def _cache_write_permission(source: DataSource) -> str:
    """A file database's caches are shared, so writing them is an edit. An
    external database's are the user's own — reading it is enough."""
    return "databases:read" if database_credential_service.is_external(source) else "databases:write"


def _stats_key(source: DataSource, user: User) -> str:
    principal = _principal(source, user)
    return f"{source.id}:{principal}" if principal else source.id


# --- Notifications (writes by an external client, e.g. an agent over MCP) ---

# What a connection test or a build writes back, and the versioning remote the
# git flow re-saves (sealed, so never equal to what was sent): the open page
# refreshes, the bell stays quiet.
_SIDE_FIELDS = {"status", "stats", "error_message", "git_remote_config"}


def _awaiting_build(source: DataSource) -> bool:
    """A managed database whose file is not made yet: the row a create-from-ddl
    or a derivation fills right after. Those announce the database; the empty
    row before them does not, or every new database would be notified twice."""
    return data_source_service.is_managed(source) and not managed_db.path_of(source.id, source.connection_config).exists()


async def _notify(
    db: AsyncSession, request: Request, user: User, action: str, source: DataSource, *, notify: bool = True,
) -> None:
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request), action=action,
        entity_type="database", entity_id=source.id, project_uid=None, label=source.name,
        detail={"workspaceId": source.workspace_id} if source.workspace_id else None, notify=notify,
    )


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
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if body.workspace_id is not None:
        await check_workspace_permission(db, body.workspace_id, user, "databases:write")
    try:
        source = await data_source_service.create(db, body, user)
    except fs_browser.FsBrowseError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc
    except data_source_service.AliasTaken as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    await _notify(db, request, user, "created", source, notify=not _awaiting_build(source))
    return source


@router.post("/test-connection", response_model=TestConnectionResult)
async def test_connection(
    body: TestConnectionRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Open a live connection to an external database, introspect it, and return
    its tables. The password in the request is used for the test only and is
    never persisted.

    The driver's error is for instance admins only (see _connection_error)."""
    await check_workspace_permission(db, body.workspace_id, user, "databases:write")
    ok, error, tables = await data_source_service.test_connection(body.connection_config)
    if not ok:
        error = _connection_error(user, "connection_test", error, workspace_id=body.workspace_id)
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
    audit.bind(action="download", data_source_id=file.data_source_id,
               detail=f"{file.file_name} ({len(data)} bytes)")
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
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    source = await _load_source(db, source_id, user, "databases:write")
    before = change_tracking.changed_values(source, body.model_dump(exclude_unset=True))
    try:
        source = await data_source_service.update(db, source, body, editor_id=user.id)
    except fs_browser.FsBrowseError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc
    except data_source_service.AliasTaken as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    if before:
        await _notify(db, request, user, "updated", source, notify=not before.keys() <= _SIDE_FIELDS)
    return source


@router.delete("/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_data_source(
    source_id: str,
    request: Request,
    delete_data: bool = Query(default=False, alias="deleteData"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """`deleteData` also removes what Linkr created for the database — a file in
    a server folder, or the SQL schema a cohort was derived into."""
    source = await _load_source(db, source_id, user, "databases:delete")
    announced = not _awaiting_build(source)
    login = None
    if delete_data and data_source_service.created_data(source) == "schema":
        login = await _login(db, source, user)
    try:
        await data_source_service.delete(db, source, delete_data=delete_data, login=login)
    except Exception as e:  # noqa: BLE001 — a failed drop keeps the database, and says why
        if not delete_data:
            raise
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"could not remove its data: {redact_secrets(str(e))}") from e
    await _notify(db, request, user, "deleted", source, notify=announced)


@router.post("/{source_id}/query", response_model=QueryResult)
async def query_data_source(
    source_id: str,
    body: QueryRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Run read-only SQL server-side against an external source (Postgres) and
    return the result rows. The server-mode counterpart to the browser's
    queryDataSource — the raw tables never reach the client, only results.

    A query still running after `deferred.WAIT_SECONDS` answers 202 and goes on as
    a job of the database's workspace (core/deferred): no gateway timeout cuts it,
    and the jobs panel can stop it, as `/query/cancel` can."""
    source = await _load_source(db, source_id, user, "databases:read")
    login = await _login(db, source, user)

    # Tagged even when the client did not ask: a job cancelled from the panel
    # cancels this coroutine, not the thread running the query, which must be
    # interrupted or it holds the database's pooled connection until it ends.
    query_id = body.query_id or uuid.uuid4().hex

    async def run() -> list[dict]:
        async with deferred.session() as session:
            fresh = await data_source_service.get(session, source_id)
            if fresh is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Data source not found")
            if body.plan:
                await data_source_service.plan_query(fresh, login, body.sql)
                return []
            return await data_source_service.query(
                session, fresh, login, body.sql, pushdown=body.pushdown, native=body.native,
            )

    async def work():
        tag = query_cancel.current_query.set((query_id, str(user.id)))
        cap = db_connect.row_cap.set(db_connect.MAX_QUERY_ROWS_ALL) if body.all_rows else None
        execution: dict = {}
        recorded = pushdown.execution.set(execution)
        try:
            rows = await deferred.until_stopped(run(), lambda: query_cancel.cancel(query_id, str(user.id)))
        except (query_cancel.QueryCancelled, duckdb.InterruptException):
            raise HTTPException(status.HTTP_409_CONFLICT, "query cancelled")
        except ValueError as e:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, redact_secrets(str(e)))
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001 — surface SQL/connection errors to the client
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, redact_secrets(str(e)))
        finally:
            query_cancel.current_query.reset(tag)
            if cap is not None:
                db_connect.row_cap.reset(cap)
            pushdown.execution.reset(recorded)
        return QueryResult(rows=rows, execution=QueryExecution(**execution) if execution else None)

    # Heavy: it waits its turn behind the heavy jobs, from the start, job or not.
    as_job = deferred.AsJob(
        "SQL query", workspace_id=source.workspace_id, lane="heavy_query" if body.heavy else None, input=body.sql,
    )
    return await deferred.respond(user.id, work, as_job)


@router.post("/{source_id}/query/cancel", response_model=QueryCancelResult)
async def cancel_query(
    source_id: str,
    body: QueryCancelRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Interrupt a query this user tagged with `queryId` and is still running (or
    about to run). Answers whether a running query was hit."""
    await _load_source(db, source_id, user, "databases:read")
    return QueryCancelResult(cancelled=query_cancel.cancel(body.query_id, str(user.id)))


@router.post("/{source_id}/query-jobs", response_model=JobResponse, status_code=status.HTTP_202_ACCEPTED)
async def start_query_job(
    source_id: str,
    body: QueryJobRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Run read queries one after the other as a job of the database's workspace,
    for work too long for one request (services/data/query_jobs). Each result is
    fetched from `…/query-jobs/{job}/results/{key}` once the job lists it done."""
    source = await _load_source(db, source_id, user, "databases:read")
    if not source.workspace_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "this database belongs to no workspace")
    login = await _login(db, source, user)
    if len({q.key for q in body.queries}) != len(body.queries):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "query keys must be unique")
    job = await query_jobs.start(
        db, source.id, source.workspace_id, user.id, body.label,
        [query_jobs.JobQuery(q.key, q.sql, q.pushdown) for q in body.queries],
        query_jobs.read_rows(login, body.pushdown), keep_going=body.keep_going,
    )
    return job


@router.get("/{source_id}/query-jobs/{job_id}/results/{key}")
async def query_job_result(
    source_id: str,
    job_id: str,
    key: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """One query's rows, as `POST /query` answers them. 404 until it is done."""
    await _load_source(db, source_id, user, "databases:read")
    job = await db.get(Job, job_id)
    if job is None or job.user_id != user.id or job.kind not in ("query", "etl") or (job.result or {}).get("sourceId") != source_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    path = query_jobs.result_path(job_id, key)
    if path is None or not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not ready")
    return FileResponse(path, media_type="application/json")


@router.post("/{source_id}/derive-plan")
async def derive_plan(
    source_id: str,
    body: DerivePlanRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """What deriving a cohort of this database would do with each of its tables."""
    source = await _load_source(db, source_id, user, "databases:read")
    try:
        return await cohort_derive_service.plan(db, source, body.level, user.id)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e


async def _notify_derivation(
    client: str | None,
    user_id: int,
    workspace_id: str | None,
    database_id: str,
    what: dict | str | None,
    phase: str,
    patient_count: int | None = None,
) -> None:
    """Tell an external client's user how a derivation it started went: `done`
    (the database it produced), or `failed` — a deleted database when the job
    removed the one made for its first build. In its own session: the job's
    runs in a worker, and the request's is gone by then."""
    if client is None:
        return
    async with jobs.async_session() as db:
        user = await db.get(User, user_id)
        database = await db.get(DataSource, database_id)
        if user is None:
            return
        await notification_service.record_change(
            db, user=user, source=client,
            action="deleted" if database is None else "updated",
            entity_type="database", entity_id=database_id, project_uid=None,
            label=database.name if database is not None else what,
            detail=_derivation_detail(phase, what, workspace_id, patient_count),
        )


def _derivation_detail(phase: str, what: dict | str | None, workspace_id: str | None, count: int | None = None) -> dict:
    return {
        "part": "derivation",
        "action": phase,
        "name": what if isinstance(what, dict) else {"en": what or ""},
        **({"count": count} if count is not None else {}),
        **({"workspaceId": workspace_id} if workspace_id else {}),
    }


@router.post("/{source_id}/derive", response_model=JobResponse, status_code=status.HTTP_202_ACCEPTED)
async def derive(
    source_id: str,
    body: DeriveRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Copy this database's tables, filtered on a cohort, into a new database or a
    new SQL schema — as a job of the database's workspace, returned queued: a
    copy of a large database takes minutes. Reading the source needs
    `databases:read`; the target is written, so it needs `databases:write` — and
    a cohort updated with the result must be one of this database's own.

    Every refusal that needs no data (target, name, write toggle) answers 400
    here, a target another derivation is still writing 409; the job's own
    failures land on the job. An external client's user is
    notified when the job starts and when it ends."""
    source = await _load_source(db, source_id, user, "databases:read")
    target = await _load_source(db, body.target.data_source_id, user, "databases:write")
    if source.workspace_id is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "only a workspace database can be derived")
    cohort = None
    if body.cohort_id:
        cohort = await db.get(Cohort, body.cohort_id)
        if cohort is None or cohort.owner_data_source_id != source.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Cohort not found")
        # Recording the derivation edits the cohort, i.e. the source database.
        await _require_source_access(db, source, user, "databases:write")
    try:
        await cohort_derive_service.validate(db, source, target, body, user.id)
        cohort_derive_service.reserve(target.id)
    except cohort_derive_service.DeriveBusy as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    except cohort_derive_service.DeriveError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e

    label = cohort_derive_service.job_label(source, target, body, cohort)
    try:
        return await _launch_derive(db, request, user, source, target, body, cohort, label)
    except BaseException:
        cohort_derive_service.release(target.id)
        raise


async def _launch_derive(
    db: AsyncSession, request: Request, user: User, source: DataSource, target: DataSource,
    body: DeriveRequest, cohort: Cohort | None, label: str,
) -> JobResponse:
    job = await jobs.create(db, None, user.id, kind="derive", label=label, workspace_id=source.workspace_id)
    ids = (source.id, target.id, cohort.id if cohort else None)
    first_build = body.target.kind == "new-database" and not (target.linkr_created or {}).get("file")
    client = notification_service.client_source(request)
    what = cohort.name if cohort is not None else ((body.derived_from or {}).get("cohort") or {}).get("name") or source.name
    workspace_id, user_id = source.workspace_id, user.id

    async def run(handle: jobs.JobHandle) -> None:
        async def progress(pct: int, line: str) -> None:
            await handle.progress(pct)
            await handle.log(line)

        audit.bind(action="derive", data_source_id=ids[0], workspace_id=workspace_id, detail=label)
        try:
            async with jobs.async_session() as job_db:
                src, dst = await job_db.get(DataSource, ids[0]), await job_db.get(DataSource, ids[1])
                if src is None or dst is None:
                    raise cohort_derive_service.DeriveError("the database was removed")
                coh = await job_db.get(Cohort, ids[2]) if ids[2] else None
                result = await cohort_derive_service.derive(job_db, src, dst, body, coh, user_id, progress)
        except BaseException:
            with contextlib.suppress(Exception):
                await _notify_derivation(client, user_id, workspace_id, ids[1], what, "failed")
            raise
        finally:
            cohort_derive_service.release(ids[1], handle.job_id)
        await handle.log(f"{result['patient_count']} patients, {len([t for t in result['tables'] if not t['skipped']])} tables")
        await handle.set_result({
            "targetId": ids[1],
            "cohortId": ids[2],
            "dataSourceId": result["data_source_id"],
            "patientCount": result["patient_count"],
            "unitCount": result["unit_count"],
            "builtAt": result["built_at"],
            "tables": result["tables"],
        })
        with contextlib.suppress(Exception):
            await _notify_derivation(
                client, user_id, workspace_id, result["data_source_id"] or ids[1], what, "done", result["patient_count"],
            )

    await notification_service.record_change(
        db, user=user, source=client,
        action="created" if first_build else "updated",
        entity_type="database", entity_id=target.id, project_uid=None, label=target.name,
        detail=_derivation_detail("started", what, workspace_id),
    )
    jobs.launch(job.id, run)
    cohort_derive_service.bind_job(target.id, job.id)
    return JobResponse.model_validate(job, from_attributes=True)


@router.post("/{source_id}/move-file", response_model=DataSourceResponse)
async def move_file(
    source_id: str,
    body: MoveFileRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Move a database Linkr created to another file location (a server folder,
    or back to Linkr's data folder). The file itself moves: nothing is left
    behind at the old place."""
    source = await _load_source(db, source_id, user, "databases:write")

    async def work():
        async with deferred.session() as session:
            fresh = await data_source_service.get(session, source_id)
            if fresh is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Data source not found")
            try:
                moved = await data_source_service.move_managed_file(session, fresh, body.path)
            except ValueError as exc:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
            return DataSourceResponse.model_validate(moved, from_attributes=True)

    # Across disks the file is copied, gigabytes of it: past `deferred.WAIT_SECONDS`
    # the move goes on as a job (core/deferred).
    as_job = deferred.AsJob(f"Move {source.name}", workspace_id=source.workspace_id) if source.workspace_id else None
    return await deferred.respond(user.id, work, as_job)


@router.post("/{source_id}/create-from-ddl", response_model=DataSourceResponse)
async def create_from_ddl(
    source_id: str,
    body: CreateFromDdlRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Materialise a server-owned DuckDB file for this source and apply the DDL.

    The browser builds the same schema in its own WASM database; in server mode
    the tables must exist on disk, or every later query hits an empty catalog."""
    source = await _load_source(db, source_id, user, "databases:write")
    try:
        config, new_location = data_source_service.claim_managed_location(source, body.path)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    path = managed_db.path_of(source.id, config)
    first_build = not path.exists()
    # A rebuild replaces a file a warm pooled connection may still hold attached
    # (browsing the database leaves one): DuckDB would refuse to open it again.
    connection_pool.invalidate(source.id)
    try:
        await asyncio.to_thread(managed_db.create_from_ddl, path, body.ddl)
    except Exception as e:  # noqa: BLE001 — a bad DDL is a client error
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, redact_secrets(str(e)))
    config["managed"] = True
    config.pop("inMemory", None)
    source = await data_source_service.update(
        db, source, DataSourceUpdate(connection_config=config), managed_path_set=new_location
    )
    await _notify(db, request, user, "created" if first_build else "updated", source)
    return source


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
    for role_source in roles.values():
        await _login(db, role_source, user)

    async def work() -> QueryResult:
        try:
            async with deferred.session() as session:
                rows = await data_source_service.run_etl(
                    session, target, body.sql, roles, user.id, body.mapping_data
                )
        except ValueError as e:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, redact_secrets(str(e)))
        except db_connect.EtlRunCancelled:
            # Stopped (`…/etl-run/stop`, the jobs panel): not a failed script.
            raise
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001 — surface SQL errors to the client
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, redact_secrets(str(e)))
        return QueryResult(rows=rows)

    # The MCP's way to run a script: past `deferred.WAIT_SECONDS` it goes on as a
    # job (core/deferred) — the app itself runs scripts as `…/etl-jobs`.
    as_job = deferred.AsJob("ETL script", workspace_id=target.workspace_id, lane="heavy_query") if target.workspace_id else None
    return await deferred.respond(user.id, work, as_job)


@router.post("/{source_id}/etl-run/stop", status_code=status.HTTP_204_NO_CONTENT)
async def stop_etl_run(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Stop the ETL run writing to this database, whoever started it — the way to
    get a database back when the page that launched the run is gone. Gated like
    starting one. Returns at once; the run then rolls back and frees the file."""
    source = await _load_source(db, source_id, user, "databases:write")
    audit.bind(action="etl_stop", data_source_id=source.id, workspace_id=source.workspace_id)
    if not data_source_service.stop_etl_run(source.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no ETL run is writing to this database")


@router.post("/{source_id}/etl-jobs", response_model=JobResponse, status_code=status.HTTP_202_ACCEPTED)
async def start_etl_job(
    source_id: str,
    body: EtlJobRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Run one ETL script on this target as a job of its workspace
    (services/data/etl_jobs): the job reports the statement it is on, and the
    last statement's rows are fetched from `…/query-jobs/{job}/results/rows`.
    Stopped like any job, from the jobs panel or `POST /jobs/{id}/cancel`."""
    target = await _load_source(db, source_id, user, "databases:write")
    if not target.workspace_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "this database belongs to no workspace")
    roles: dict[str, DataSource] = {}
    for role, ds_id in (body.roles or {}).items():
        if role == "target" or not ds_id:
            continue
        roles[role] = await _load_source(db, ds_id, user, "databases:read")
    for role_source in roles.values():
        await _login(db, role_source, user)
    return await etl_jobs.start(db, target, roles, user.id, body.label, body.sql, body.mapping_data)


@router.post("/{source_id}/retest", response_model=TestConnectionResult)
async def retest_data_source(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Re-validate a stored source using its saved (encrypted) credentials — no
    password from the client. Returns ok + introspected tables so the UI can
    refresh status and stats.

    Read permission: this opens the database and reports whether it answered,
    writing nothing. Gating it on `databases:write` left a reader looking at a
    stale `error` with no way to re-check it.
    """
    source = await _load_source(db, source_id, user, "databases:read")
    ok, error, tables = await data_source_service.test_connection_stored(source, await _login(db, source, user))
    if not ok and _reaches_the_network(source):
        error = _connection_error(user, "retest", error, source)
    return TestConnectionResult(ok=ok, error=error, tables=tables)


def _reaches_the_network(source) -> bool:
    """An external engine's driver error names hosts and ports that answer (see
    `_connection_error`); a managed or uploaded file's names only its own file."""
    return (
        not data_source_service.is_managed(source)
        and data_source_service.is_external_engine((source.connection_config or {}).get("engine"))
    )


def _connection_error(
    user: User, action: str, error: object, source: DataSource | None = None, workspace_id: str | None = None,
) -> str:
    """What the caller is told when an external database did not answer.

    The driver's text names the hosts and ports that do: returned to anyone, it
    makes the server a scanner of the network it sits in (docs/design/spe-security.md).
    So only an instance admin reads it in the reply; everyone else gets "Connection
    failed" and a reference, and the text goes to the access log and the server
    log, where that reference finds it."""
    text = redact_secrets(str(error))
    logger.info("%s of %s failed: %s", action, source.id if source else "a new connection", text)
    audit.bind(
        action=action, error=text,
        data_source_id=source.id if source else None,
        workspace_id=source.workspace_id if source else workspace_id,
    )
    return text if user.role == "admin" else audit.with_reference("Connection failed")


@router.get("/{source_id}/flight", response_model=FlightStatus)
async def get_flight_status(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Whether Arrow Flight carries this database's large results, and if not why:
    the database page warns that they go over the slower MySQL protocol."""
    source = await _load_source(db, source_id, user, "databases:read")
    login = await _login(db, source, user)
    try:
        return await data_source_service.flight_status(source, login)
    except database_credential_service.CredentialRequired:
        raise
    except Exception as e:  # noqa: BLE001 — the database itself is unreachable: the page says so elsewhere
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, _connection_error(user, "flight_check", e, source)) from e


@router.get("/{source_id}/schema", response_model=list[IntrospectedTable])
async def get_data_source_schema(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Introspected tables + columns of an external source, for the schema
    mapping / table-discovery UI. Uses the stored (encrypted) credentials."""
    source = await _load_source(db, source_id, user, "databases:read")
    login = await _login(db, source, user)
    try:
        return await data_source_service.introspect(db, source, login)
    except HTTPException:  # no login, or an ETL run holding the file
        raise
    except Exception as e:  # noqa: BLE001 — the driver's message is the diagnosis
        # Reaching the database is the one thing this route does, so a driver
        # failure is not a server fault: unhandled, it became a bare 500 whose
        # "Internal server error" hid the only text that says what went wrong —
        # a held file lock, a missing file. An external engine's text is for
        # instance admins only (_connection_error).
        if _reaches_the_network(source):
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, _connection_error(user, "introspect", e, source)) from e
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, redact_secrets(str(e))) from e


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
    return await data_source_service.connection_info(db, source, user.id)


def _compact_status(state: data_source_service.CompactionState) -> CompactStatus:
    return CompactStatus(
        status=state.status,
        size_before=state.size_before,
        size_after=state.size_after,
        data_size=state.data_size,
        bytes_written=state.bytes_written,
        error=state.error,
    )


@router.post("/{source_id}/compact", response_model=CompactStatus)
async def compact_database(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Start rewriting a managed DuckDB file without its free blocks.

    Returns as soon as the work is under way — a multi-GB rewrite outlives any
    sensible HTTP timeout — and the client polls the GET twin below. Gated on
    `databases:write`: it rewrites the file in place. The data is unchanged; this
    reclaims space a dropped table left behind, which DuckDB never returns to the
    filesystem on its own.
    """
    source = await _load_source(db, source_id, user, "databases:write")
    try:
        state = await data_source_service.start_compaction(source, user.id)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    return _compact_status(state)


@router.get("/{source_id}/compact", response_model=CompactStatus)
async def compact_database_status(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Progress of the compaction started by the POST twin.

    404 when none has run for this database in this server process: the state is
    in memory, so a restart mid-compaction loses the readout (never the file,
    which is a temp copy plus an atomic rename).
    """
    await _load_source(db, source_id, user, "databases:read")
    state = data_source_service.compaction_state(source_id)
    if state is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no compaction for this database")
    return _compact_status(state)


@router.post("/{source_id}/parquet-layout", response_model=list[ParquetLayoutEntry])
async def parquet_layout(
    source_id: str,
    body: ParquetLayoutRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """How a lookup by each asked column reads its table's Parquet files — the
    row-group statistics only, no row is read. Empty unless the source is a
    Parquet folder."""
    source = await _load_source(db, source_id, user, "databases:read")
    checks = [c.model_dump(by_alias=True) for c in body.checks]
    return await data_source_service.parquet_layout(db, source, checks)


@router.get("/{source_id}/concept-cache", response_model=ConceptCacheStatus)
async def concept_cache_status(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Whether the caller's view of the source has a materialized concept-list
    cache, its "last refreshed" time (the Parquet file's mtime), and where the
    counting run that writes it stands."""
    source = await _load_source(db, source_id, user, "databases:read")
    principal = _principal(source, user)
    return ConceptCacheStatus(
        exists=concept_cache_fs.exists(source_id, principal),
        refreshed_at=concept_cache_fs.refreshed_at(source_id, principal),
        run=concept_cache_fs.run_status(source_id, principal),
    )


@router.put("/{source_id}/concept-cache/run", status_code=status.HTTP_204_NO_CONTENT)
async def start_concept_run(
    source_id: str,
    body: ConceptRunStart,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Store the counting run's manifest — `reset` drops the units already done.
    For a file database the cache is shared, so it takes the editor role; for an
    external one it is the caller's own."""
    source = await _load_source(db, source_id, user, "databases:read")
    await _require_source_access(db, source, user, _cache_write_permission(source))
    login = await _login(db, source, user)
    try:
        await data_source_service.start_concept_run(source, login, body.manifest, body.reset)
    except concept_cache_fs.RunConflict as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e))
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))


@router.post("/{source_id}/concept-cache/units-job", response_model=JobResponse, status_code=status.HTTP_202_ACCEPTED)
async def start_concept_units_job(
    source_id: str,
    body: ConceptUnitsJobRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Run counting units of run `runId` as a job of the database's workspace, for
    units too long for one request — 409 when that run is no longer the stored
    one. The job lists each unit done once its file is kept."""
    source = await _load_source(db, source_id, user, "databases:read")
    await _require_source_access(db, source, user, _cache_write_permission(source))
    if not source.workspace_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "this database belongs to no workspace")
    login = await _login(db, source, user)
    if len({u.key for u in body.units}) != len(body.units):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "unit keys must be unique")
    run = concept_cache_fs.run_status(source.id, _principal(source, user))
    if run is None or run["manifest"].get("runId") != body.run_id:
        raise HTTPException(status.HTTP_409_CONFLICT, "this counting run was replaced")
    return await query_jobs.start(
        db, source.id, source.workspace_id, user.id, body.label,
        [query_jobs.JobQuery(u.key, u.sql) for u in body.units], query_jobs.write_concept_units(login, body.run_id),
    )


@router.post("/{source_id}/concept-cache/assemble", response_model=ConceptCacheStatus)
async def assemble_concept_cache(
    source_id: str,
    body: ConceptCacheAssembleRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Write the concept list from the units done so far. Atomic: readers keep
    seeing the previous list until the new one is in place."""
    source = await _load_source(db, source_id, user, "databases:read")
    await _require_source_access(db, source, user, _cache_write_permission(source))
    login = await _login(db, source, user)
    try:
        mtime = await data_source_service.assemble_concept_cache(db, source, login, body.select_sql)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, redact_secrets(str(e)))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — surface SQL/connection errors to the client
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, redact_secrets(str(e)))
    principal = _principal(source, user)
    return ConceptCacheStatus(
        exists=True, refreshed_at=mtime, run=concept_cache_fs.run_status(source_id, principal),
    )


@router.post("/{source_id}/concept-cache/query", response_model=ConceptPageResult)
async def query_concept_cache(
    source_id: str,
    body: ConceptPageRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Run a page/filter/sort query against the cached concept Parquet (view
    `concepts`). 404 if the cache has not been built yet."""
    source = await _load_source(db, source_id, user, "databases:read")
    try:
        rows = await data_source_service.query_concept_cache(source_id, _principal(source, user), body.sql)
    except FileNotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No concept cache")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, redact_secrets(str(e)))
    return ConceptPageResult(rows=rows)


@router.post("/{source_id}/concept-cache/relations", response_model=ConceptRelationsResult)
async def concept_cache_relations(
    source_id: str,
    body: ConceptRelationsRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The event relations the last counting run counted, and which of them hold
    any of `conceptIds` — a patient's timeline then reads only those."""
    source = await _load_source(db, source_id, user, "databases:read")
    ids = [str(i) for i in body.concept_ids]
    relations = await asyncio.to_thread(concept_cache_fs.counted_relations, source_id, _principal(source, user), ids)
    return ConceptRelationsResult(relations=relations)


@router.get(
    "/{source_id}/concept-stats/{concept_id}", response_model=ConceptStatsResponse
)
async def get_concept_stats(
    source_id: str,
    concept_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Cached detail-panel stats for one concept, as the caller sees the source.
    404 until first computed."""
    source = await _load_source(db, source_id, user, "databases:read")
    row = await concept_stats_cache_service.get(db, source_id, concept_id, _principal(source, user))
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
    """Persist the stats a client computed for one concept, for everyone who sees
    the source through the same principal."""
    source = await _load_source(db, source_id, user, "databases:read")
    await _require_source_access(db, source, user, _cache_write_permission(source))
    return await concept_stats_cache_service.save(
        db, source_id, concept_id, _principal(source, user), body.stats
    )


_STATS_SCOPE = "database"


@router.get("/{source_id}/stats-cache", response_model=StatsCacheResponse | None)
async def get_database_stats_cache(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Precomputed database statistics for this source as the caller sees it
    (null if none). Stored server-side so everyone of the same principal reuses
    one computed payload."""
    source = await _load_source(db, source_id, user, "databases:read")
    row = await stats_cache_service.get(db, _STATS_SCOPE, _stats_key(source, user))
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
    """Store the statistics a client just computed, for everyone who sees the
    source through the same principal."""
    source = await _load_source(db, source_id, user, "databases:read")
    await _require_source_access(db, source, user, _cache_write_permission(source))
    await stats_cache_service.save(
        db, _STATS_SCOPE, _stats_key(source, user), body.computed_at, body.payload
    )
    return StatsCacheResponse(computed_at=body.computed_at, payload=body.payload)


@router.delete("/{source_id}/stats-cache", status_code=status.HTTP_204_NO_CONTENT)
async def delete_database_stats_cache(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Reset the shared statistics cache for this source (the "reset" button)."""
    # Cache reset is a recompute, not deleting the source → write, not delete.
    source = await _load_source(db, source_id, user, "databases:read")
    await _require_source_access(db, source, user, _cache_write_permission(source))
    await stats_cache_service.delete(db, _STATS_SCOPE, _stats_key(source, user))


@router.get("/{source_id}/files", response_model=list[DataSourceFileResponse])
async def list_data_source_files(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_source(db, source_id, user, "databases:read")
    return await data_source_service.list_files(db, source_id)


# --- The acting user's own login ------------------------------------------------

@router.get("/{source_id}/my-login", response_model=DatabaseLoginStatus)
async def get_my_login(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    source = await _load_source(db, source_id, user, "databases:read")
    state = await database_credential_service.status_for(db, source, user.id)
    return DatabaseLoginStatus(
        has_login=state["hasLogin"],
        username=state["username"],
        remembered=state["remembered"],
        last_used_at=state["lastUsedAt"],
        session_only=source.require_session_only,
    )


@router.put("/{source_id}/my-login", response_model=DatabaseLoginStatus)
async def save_my_login(
    source_id: str,
    body: DatabaseLoginSave,
    user: User = Depends(get_session_user),
    db: AsyncSession = Depends(get_db),
):
    """Test the login against the database, and keep it only if it connects.
    Session JWT only: an agent's API key never sets a password."""
    source = await _load_source(db, source_id, user, "databases:read")
    audit.bind(action="credential_set", data_source_id=source.id, workspace_id=source.workspace_id,
               detail=f"username={body.username} remember={body.remember}")
    if not database_credential_service.is_external(source):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "this database takes no login")
    config = {**(source.connection_config or {}), "username": body.username, "password": body.password}
    ok, error, _tables = await data_source_service.test_connection(config)
    if not ok:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, error or "could not connect")
    await database_credential_service.save(
        db, source, user.id, body.username, body.password, remember=body.remember
    )
    return await get_my_login(source_id, user, db)


@router.delete("/{source_id}/my-login", status_code=status.HTTP_204_NO_CONTENT)
async def forget_my_login(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    source = await _load_source(db, source_id, user, "databases:read")
    audit.bind(action="credential_forget", data_source_id=source.id, workspace_id=source.workspace_id)
    await database_credential_service.forget(db, source, user.id)


@router.get("/{source_id}/login-count")
async def login_count(
    source_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """How many users hold a login to this database — the number the settings
    dialog warns about before a change of target drops them all."""
    await _load_source(db, source_id, user, "databases:write")
    return {"count": await database_credential_service.count_for_source(db, source_id)}
