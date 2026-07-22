from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.base import CamelModel

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
from app.models.mapping_project import ConceptMapping, MappingProject, ServiceMapping
from app.models.user import User
from app.schemas.mapping_project import (
    ConceptMappingBatch,
    ConceptMappingCreate,
    ConceptMappingDeleteByProjects,
    ConceptMappingDeleteOrphans,
    ConceptMappingResponse,
    ConceptMappingUpdate,
    MappingProjectCreate,
    MappingProjectResponse,
    MappingProjectUpdate,
    ServiceMappingCreate,
    ServiceMappingResponse,
    ServiceMappingUpdate,
)
import asyncio

from app.services import blob_store
from app.services import mapping_project_service as svc
from app.services import source_concept_id_service as sci_svc
from app.services.data.global_table_service import _localized
from app.services.mapping_project_export_assemble import assemble_mapping_project_zip
from app.services.data import dataset_parser, db_connect, file_reader
from app.services.data import global_table_service
from app.services.data import scores_service
from app.services.data.file_source import (
    build_source_concepts_select,
    source_concepts_dedup_partition,
)

router = APIRouter(tags=["mapping-projects"])

_PROJ = "/mapping-projects"
_MAP = "/concept-mappings"
_SVC = "/service-mappings"


def _attachment_disposition(filename: str) -> str:
    """RFC 5987 Content-Disposition. Starlette latin-1-encodes headers, so a raw
    non-latin1 filename (CJK / em-dash / emoji in a project name) would raise
    UnicodeEncodeError → 500. Emit an ASCII fallback plus a UTF-8 filename*."""
    import urllib.parse

    ascii_name = filename.encode("ascii", "replace").decode("ascii").replace('"', "'")
    utf8_name = urllib.parse.quote(filename)
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{utf8_name}"


async def _load_project(
    db: AsyncSession, project_id: str, user: User, permission: str
) -> MappingProject:
    project = await svc.get(db, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_permission(db, project.workspace_id, user, permission)
    return project


async def _load_mapping(
    db: AsyncSession, mapping_id: str, user: User, permission: str
) -> ConceptMapping:
    mapping = await svc.get_mapping(db, mapping_id)
    if mapping is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _load_project(db, mapping.project_id, user, permission)
    return mapping


async def _load_service_mapping(
    db: AsyncSession, mapping_id: str, user: User, permission: str
) -> ServiceMapping:
    mapping = await svc.get_service_mapping(db, mapping_id)
    if mapping is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_permission(db, mapping.workspace_id, user, permission)
    return mapping


# --- Mapping projects ------------------------------------------------------


@router.get(_PROJ, response_model=list[MappingProjectResponse])
async def list_projects(
    workspace_id: str | None = Query(default=None, alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if workspace_id is not None:
        await check_workspace_permission(db, workspace_id, user, "concept-mapping:read")
        return await svc.list_for_workspace(db, workspace_id)
    projects = await svc.list_all(db)
    visible: list[MappingProject] = []
    for p in projects:
        try:
            await check_workspace_permission(
                db, p.workspace_id, user, "concept-mapping:read"
            )
            visible.append(p)
        except HTTPException:
            continue
    return visible


@router.post(
    _PROJ, response_model=MappingProjectResponse, status_code=status.HTTP_201_CREATED
)
async def create_project(
    body: MappingProjectCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(
        db, body.workspace_id, user, "concept-mapping:write"
    )
    return await svc.create(db, body, user)


@router.get(_PROJ + "/{project_id}", response_model=MappingProjectResponse)
async def get_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load_project(db, project_id, user, "concept-mapping:read")


@router.patch(_PROJ + "/{project_id}", response_model=MappingProjectResponse)
async def update_project(
    project_id: str,
    body: MappingProjectUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await _load_project(db, project_id, user, "concept-mapping:write")
    return await svc.update(db, project, body)


@router.delete(_PROJ + "/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await _load_project(db, project_id, user, "concept-mapping:delete")
    await svc.delete(db, project)


# --- Cross-project overview Table (build cache once, then query pages) --------
# Declared before the /{project_id}/... routes so `/global-table/query` isn't
# captured by `/{project_id}/query` (Starlette matches in registration order).


def _normalize_mode(mode: str) -> str:
    return mode if mode in ("flat", "dedup") else "flat"


async def _load_global_table_inputs(db: AsyncSession, workspace_id: str):
    """Reload the merged-table inputs from the app DB. This is the expensive part
    (all mappings + the assigned-id registry), so it runs only in the `build`
    step — not on every filter/page of the `query` step."""
    projects = await svc.list_for_workspace(db, workspace_id)
    project_dicts = [_project_to_dict(p) for p in projects]
    mappings_by_project = {
        p.id: [_mapping_to_dict(m) for m in await svc.list_mappings(db, p.id)]
        for p in projects
    }
    entries = await sci_svc.list_entries(db, workspace_id)
    registry = {
        f"{e.vocabulary_id}__{e.concept_code}": e.source_concept_id for e in entries
    }
    return project_dicts, mappings_by_project, registry


class GlobalTableBuild(CamelModel):
    workspace_id: str
    mode: str = "flat"  # 'flat' (project) | 'dedup' (badge)


@router.post(_PROJ + "/global-table/build")
async def global_table_build(
    body: GlobalTableBuild,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """(Re)build the cross-project overview cache for one (workspace, mode) and
    return its cache signature + the distinct filter values (e.g. source
    vocabulary). Call this once when the Table opens or after a data change; then
    hit `/global-table/query` with the returned signature for each page/filter —
    that path reads the Parquet directly and never touches the app DB."""
    await check_workspace_permission(
        db, body.workspace_id, user, "concept-mapping:read"
    )
    mode = _normalize_mode(body.mode)
    project_dicts, mappings_by_project, registry = await _load_global_table_inputs(
        db, body.workspace_id
    )

    def _run():
        signature = global_table_service.cache_signature(
            project_dicts, mappings_by_project, registry
        )
        path = global_table_service.get_or_build_cache(
            body.workspace_id,
            mode,
            project_dicts,
            mappings_by_project,
            registry,
        )
        total = global_table_service.query_page(path, mode, {}, None, 0, 0)[1]
        filter_values = global_table_service.distinct_filter_values(path, mode)
        return signature, total, filter_values

    try:
        signature, total, filter_values = await asyncio.to_thread(_run)
    except file_reader.ExcelSupportUnavailable:
        raise HTTPException(
            status.HTTP_501_NOT_IMPLEMENTED, "excel_support_unavailable"
        )
    except Exception as e:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"Global table build failed: {e}"
        )
    return {"signature": signature, "total": total, "filterValues": filter_values}


class GlobalTableQuery(CamelModel):
    workspace_id: str
    signature: str
    mode: str = "flat"
    filters: dict = {}
    sort: dict | None = None
    limit: int = 50
    offset: int = 0


@router.post(_PROJ + "/global-table/query")
async def global_table_query(
    body: GlobalTableQuery,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """One page of the cross-project overview Table, read straight from the cached
    Parquet identified by `signature` — no app-DB reload, no rebuild. If the cache
    for this signature is gone (inputs changed since the last build), return 409
    so the client re-runs `/global-table/build`."""
    await check_workspace_permission(
        db, body.workspace_id, user, "concept-mapping:read"
    )
    mode = _normalize_mode(body.mode)

    def _run():
        path = global_table_service.cached_path_or_raise(
            body.workspace_id, mode, body.signature
        )
        return global_table_service.query_page(
            path,
            mode,
            body.filters,
            body.sort,
            body.limit,
            body.offset,
        )

    try:
        rows, total = await asyncio.to_thread(_run)
    except global_table_service.CacheMissing:
        raise HTTPException(status.HTTP_409_CONFLICT, "cache_stale")
    except Exception as e:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"Global table query failed: {e}"
        )
    return {"rows": rows, "total": total}


# --- Source-CSV blob (uploaded separately via /uploads, referenced by sha) --


class RawFileRef(CamelModel):
    sha: str
    file_name: str | None = None


@router.post(_PROJ + "/{project_id}/raw-file", response_model=MappingProjectResponse)
async def set_raw_file(
    project_id: str,
    body: RawFileRef,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await _load_project(db, project_id, user, "concept-mapping:write")
    if not blob_store.exists(body.sha):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Uploaded file not found")
    return await svc.update(
        db,
        project,
        MappingProjectUpdate(raw_file_sha=body.sha, raw_file_name=body.file_name),
    )


class FileSourceQuery(CamelModel):
    sql: str


@router.post(_PROJ + "/{project_id}/query")
async def query_file_source(
    project_id: str,
    body: FileSourceQuery,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Run the frontend's SQL over a file-source project's CSV (server-side
    DuckDB). The CSV is projected to the `source_concepts` view via the project's
    columnMapping, mirroring the browser's DuckDB-WASM mount."""
    # Editor, not viewer: this runs arbitrary client SQL over the file source's
    # server-side DuckDB (a distinct, powerful capability), not a read of already
    # projected rows.
    project = await _load_project(db, project_id, user, "concept-mapping:write")
    if not project.raw_file_sha or not blob_store.exists(project.raw_file_sha):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No source file")
    fsd = project.file_source_data or {}
    column_mapping = fsd.get("columnMapping", {})
    parse_options = fsd.get("parseOptions", {})
    select_sql = build_source_concepts_select(column_mapping)
    dedup_partition = source_concepts_dedup_partition(column_mapping)
    path = str(blob_store.path_for(project.raw_file_sha))
    try:
        rows = await asyncio.to_thread(
            db_connect.query_file_source,
            path,
            project.raw_file_name,
            parse_options,
            select_sql,
            dedup_partition,
            body.sql,
        )
    except file_reader.ExcelSupportUnavailable:
        raise HTTPException(
            status.HTTP_501_NOT_IMPLEMENTED, "excel_support_unavailable"
        )
    except Exception as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Query failed: {e}")
    return rows


# --- Suggestion-scores blob (precomputed match scores parquet) -------------


class ScoresFileRef(CamelModel):
    sha: str
    file_name: str | None = None


@router.post(_PROJ + "/{project_id}/scores-file")
async def set_scores_file(
    project_id: str,
    body: ScoresFileRef,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Attach an uploaded scores parquet to a project: validate it, build the
    query index, and store the sha pointer. Returns the ScoresIndex the client
    caches for the "has suggestions" badges."""
    project = await _load_project(db, project_id, user, "concept-mapping:write")
    if not blob_store.exists(body.sha):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Uploaded file not found")
    path = str(blob_store.path_for(body.sha))
    ok, error = await asyncio.to_thread(scores_service.validate, path)
    if not ok:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, error or "Invalid scores file")
    await svc.update(
        db,
        project,
        MappingProjectUpdate(scores_file_sha=body.sha, scores_file_name=body.file_name),
    )
    return await asyncio.to_thread(scores_service.build_index, project_id, path)


@router.get(_PROJ + "/{project_id}/scores-index")
async def get_scores_index(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Rebuild the query index from the persisted parquet (no upload). Returns
    null when the project has no scores file."""
    project = await _load_project(db, project_id, user, "concept-mapping:read")
    if not project.scores_file_sha or not blob_store.exists(project.scores_file_sha):
        return None
    blob_path = blob_store.path_for(project.scores_file_sha)
    path = str(blob_path)
    index = await asyncio.to_thread(scores_service.build_index, project_id, path)
    index["fileSize"] = blob_path.stat().st_size
    return index


class ScoresQuery(CamelModel):
    vocabulary_id: str
    concept_code: str


@router.post(_PROJ + "/{project_id}/scores/query")
async def query_scores(
    project_id: str,
    body: ScoresQuery,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Score rows for one (vocabulary, code) — the per-source lookup the
    Suggestions panel runs. Reads the parquet server-side; only matching rows
    descend to the browser."""
    project = await _load_project(db, project_id, user, "concept-mapping:read")
    if not project.scores_file_sha or not blob_store.exists(project.scores_file_sha):
        return []
    path = str(blob_store.path_for(project.scores_file_sha))
    return await asyncio.to_thread(
        scores_service.query_scores, path, body.vocabulary_id, body.concept_code
    )


@router.get(_PROJ + "/{project_id}/scores-file")
async def get_scores_file(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Download the scores parquet from the blob store (for export). 404 when the
    project has no scores file."""
    project = await _load_project(db, project_id, user, "concept-mapping:read")
    if not project.scores_file_sha or not blob_store.exists(project.scores_file_sha):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No scores file")
    data = await blob_store.read_bytes(project.scores_file_sha)
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            "x-file-name": project.scores_file_name or "similarity-scores.parquet"
        },
    )


@router.delete(
    _PROJ + "/{project_id}/scores-file", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_scores_file(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await _load_project(db, project_id, user, "concept-mapping:delete")
    await svc.update(
        db,
        project,
        MappingProjectUpdate(scores_file_sha=None, scores_file_name=None),
    )


class FileColumnsPreview(CamelModel):
    workspace_id: str
    sha: str
    file_name: str
    parse_options: dict | None = None
    # Rows to materialize for the dialog's preview/auto-mapping (0 = names only).
    preview_rows: int = 0


@router.post(_PROJ + "/preview-columns")
async def preview_file_columns(
    body: FileColumnsPreview,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Columns + row count (+ optional preview rows + Excel sheet names) of an
    already-uploaded blob, before a project exists. Lets the create dialog map
    columns server-side without a browser parse (papaparse/xlsx/DuckDB-WASM), so
    the previewed columns match exactly what the mapping query reads.

    Blobs are globally content-addressed, so gate on editor rights in the target
    workspace: without it any authenticated user could read the schema/row count
    of any workspace's upload by guessing/knowing its sha."""
    await check_workspace_permission(
        db, body.workspace_id, user, "concept-mapping:write"
    )
    if not blob_store.exists(body.sha):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Uploaded file not found")
    path = str(blob_store.path_for(body.sha))
    try:
        cols, total, rows = await asyncio.to_thread(
            db_connect.file_source_columns,
            path,
            body.file_name,
            body.parse_options,
            body.preview_rows,
        )
        sheet_names = (
            await asyncio.to_thread(dataset_parser.excel_sheet_names, blob_store.path_for(body.sha))
            if file_reader.is_excel(body.file_name)
            else None
        )
    except file_reader.ExcelSupportUnavailable:
        raise HTTPException(
            status.HTTP_501_NOT_IMPLEMENTED, "excel_support_unavailable"
        )
    except Exception as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Preview failed: {e}")
    return {"columns": cols, "rowCount": total, "rows": rows, "sheetNames": sheet_names}


def _project_to_dict(p: MappingProject) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "source_type": p.source_type,
        "updated_at": p.updated_at,
        "badges": p.badges,
        "raw_file_sha": p.raw_file_sha,
        "raw_file_name": p.raw_file_name,
        "file_source_data": p.file_source_data,
        "data_source_id": p.data_source_id,
    }


def _mapping_to_dict(m: ConceptMapping) -> dict:
    return {
        "id": m.id,
        "source_vocabulary_id": m.source_vocabulary_id,
        "source_concept_code": m.source_concept_code,
        "source_concept_name": m.source_concept_name,
        "source_concept_id": m.source_concept_id,
        "target_vocabulary_id": m.target_vocabulary_id,
        "target_concept_id": m.target_concept_id,
        "target_concept_name": m.target_concept_name,
        "equivalence": m.equivalence,
        "status": m.status,
        "mapped_by": m.mapped_by,
        "reviews": m.reviews,
        "created_at": m.created_at,
        "updated_at": m.updated_at,
    }


@router.get(_PROJ + "/{project_id}/raw-file")
async def get_raw_file(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await _load_project(db, project_id, user, "concept-mapping:read")
    if not project.raw_file_sha or not blob_store.exists(project.raw_file_sha):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No source file")
    data = await blob_store.read_bytes(project.raw_file_sha)
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"x-file-name": project.raw_file_name or "source.csv"},
    )


@router.get(_PROJ + "/{project_id}/export-zip")
async def export_zip(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Build the project's export ZIP server-side and return it for download —
    the git variant tree (project.json, mappings.json, source-concepts.csv,
    source-concept-ids/, .gitignore). Offloads the browser: no data comes down
    just to be re-zipped. See docs/architecture.md ("Fullstack Storage & Compute")."""
    project = await _load_project(db, project_id, user, "concept-mapping:read")
    zip_bytes = await assemble_mapping_project_zip(db, project)
    slug = _localized(project.name, "en") or project.id
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"content-disposition": _attachment_disposition(f"{slug}.zip")},
    )


# --- Concept mappings (per-project) ----------------------------------------


@router.get(
    _PROJ + "/{project_id}/mappings", response_model=list[ConceptMappingResponse]
)
async def list_mappings(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_project(db, project_id, user, "concept-mapping:read")
    return await svc.list_mappings(db, project_id)


@router.get(_PROJ + "/{project_id}/stats")
async def get_project_stats(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Review-aware mapped/approved/flagged/ignored counts computed server-side
    (dedup by source key), so the client never rehydrates every mapping just to
    recount after a vote. totalSourceConcepts/unmappedCount are 0 here (the
    source table lives client- or DuckDB-side)."""
    await _load_project(db, project_id, user, "concept-mapping:read")
    return await svc.compute_project_stats(db, project_id)


@router.get("/workspaces/{workspace_id}/mapping-mapped-keys")
async def get_workspace_mapped_keys(
    workspace_id: str,
    exclude: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[str]:
    """Distinct `vocab:code` keys mapped in this workspace's OTHER mapping
    projects — the "already mapped elsewhere" set. One query instead of the
    client's per-project scan."""
    await check_workspace_permission(db, workspace_id, user, "concept-mapping:read")
    return await svc.workspace_mapped_keys(db, workspace_id, exclude)


@router.delete(_PROJ + "/{project_id}/mappings", status_code=status.HTTP_204_NO_CONTENT)
async def delete_mappings_for_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_project(db, project_id, user, "concept-mapping:delete")
    await svc.delete_mappings_for_project(db, project_id)


@router.post(
    _MAP, response_model=ConceptMappingResponse, status_code=status.HTTP_201_CREATED
)
async def create_mapping(
    body: ConceptMappingCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_project(db, body.project_id, user, "concept-mapping:write")
    return await svc.create_mapping(db, body)


@router.post(_MAP + "/batch", status_code=status.HTTP_204_NO_CONTENT)
async def create_mappings_batch(
    body: ConceptMappingBatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    for pid in {m.project_id for m in body.mappings}:
        await _load_project(db, pid, user, "concept-mapping:write")
    await svc.create_mappings_batch(db, body.mappings)


@router.post(_MAP + "/delete-by-projects", status_code=status.HTTP_204_NO_CONTENT)
async def delete_by_projects(
    body: ConceptMappingDeleteByProjects,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    for pid in body.project_ids:
        await _load_project(db, pid, user, "concept-mapping:delete")
    await svc.delete_mappings_for_projects(db, body.project_ids)


@router.post(_MAP + "/delete-orphans", status_code=status.HTTP_204_NO_CONTENT)
async def delete_orphans(
    body: ConceptMappingDeleteOrphans,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Admin-only housekeeping: prune mappings whose project is gone. Restrict to
    # admins since it operates across all projects.
    if user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin only")
    await svc.delete_orphan_mappings(db, body.valid_project_ids)


@router.patch(_MAP + "/{mapping_id}", response_model=ConceptMappingResponse)
async def update_mapping(
    mapping_id: str,
    body: ConceptMappingUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    mapping = await _load_mapping(db, mapping_id, user, "concept-mapping:write")
    return await svc.update_mapping(db, mapping, body)


@router.delete(_MAP + "/{mapping_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_mapping(
    mapping_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    mapping = await _load_mapping(db, mapping_id, user, "concept-mapping:delete")
    await svc.delete_mapping(db, mapping)


# --- Service mappings ------------------------------------------------------


@router.get(_SVC, response_model=list[ServiceMappingResponse])
async def list_service_mappings(
    workspace_id: str | None = Query(default=None, alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if workspace_id is not None:
        await check_workspace_permission(db, workspace_id, user, "concept-mapping:read")
        return await svc.list_service_mappings_for_workspace(db, workspace_id)
    mappings = await svc.list_service_mappings_all(db)
    visible: list[ServiceMapping] = []
    for m in mappings:
        try:
            await check_workspace_permission(
                db, m.workspace_id, user, "concept-mapping:read"
            )
            visible.append(m)
        except HTTPException:
            continue
    return visible


@router.post(
    _SVC, response_model=ServiceMappingResponse, status_code=status.HTTP_201_CREATED
)
async def create_service_mapping(
    body: ServiceMappingCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(
        db, body.workspace_id, user, "concept-mapping:write"
    )
    return await svc.create_service_mapping(db, body)


@router.get(_SVC + "/{mapping_id}", response_model=ServiceMappingResponse)
async def get_service_mapping(
    mapping_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load_service_mapping(db, mapping_id, user, "concept-mapping:read")


@router.patch(_SVC + "/{mapping_id}", response_model=ServiceMappingResponse)
async def update_service_mapping(
    mapping_id: str,
    body: ServiceMappingUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    mapping = await _load_service_mapping(db, mapping_id, user, "concept-mapping:write")
    return await svc.update_service_mapping(db, mapping, body)


@router.delete(_SVC + "/{mapping_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_service_mapping(
    mapping_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    mapping = await _load_service_mapping(
        db, mapping_id, user, "concept-mapping:delete"
    )
    await svc.delete_service_mapping(db, mapping)
