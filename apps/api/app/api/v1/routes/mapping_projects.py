from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.base import CamelModel

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_role
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
from app.services.data import db_connect, file_reader
from app.services.data import global_table_service
from app.services.data.file_source import build_source_concepts_select

router = APIRouter(tags=["mapping-projects"])

_PROJ = "/mapping-projects"
_MAP = "/concept-mappings"
_SVC = "/service-mappings"


async def _load_project(
    db: AsyncSession, project_id: str, user: User, min_role: str
) -> MappingProject:
    project = await svc.get(db, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_role(db, project.workspace_id, user, min_role)
    return project


async def _load_mapping(
    db: AsyncSession, mapping_id: str, user: User, min_role: str
) -> ConceptMapping:
    mapping = await svc.get_mapping(db, mapping_id)
    if mapping is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _load_project(db, mapping.project_id, user, min_role)
    return mapping


async def _load_service_mapping(
    db: AsyncSession, mapping_id: str, user: User, min_role: str
) -> ServiceMapping:
    mapping = await svc.get_service_mapping(db, mapping_id)
    if mapping is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_role(db, mapping.workspace_id, user, min_role)
    return mapping


# --- Mapping projects ------------------------------------------------------

@router.get(_PROJ, response_model=list[MappingProjectResponse])
async def list_projects(
    workspace_id: str | None = Query(default=None, alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if workspace_id is not None:
        await check_workspace_role(db, workspace_id, user, "viewer")
        return await svc.list_for_workspace(db, workspace_id)
    projects = await svc.list_all(db)
    visible: list[MappingProject] = []
    for p in projects:
        try:
            await check_workspace_role(db, p.workspace_id, user, "viewer")
            visible.append(p)
        except HTTPException:
            continue
    return visible


@router.post(_PROJ, response_model=MappingProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: MappingProjectCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_role(db, body.workspace_id, user, "editor")
    return await svc.create(db, body)


@router.get(_PROJ + "/{project_id}", response_model=MappingProjectResponse)
async def get_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load_project(db, project_id, user, "viewer")


@router.patch(_PROJ + "/{project_id}", response_model=MappingProjectResponse)
async def update_project(
    project_id: str,
    body: MappingProjectUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await _load_project(db, project_id, user, "editor")
    return await svc.update(db, project, body)


@router.delete(_PROJ + "/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await _load_project(db, project_id, user, "editor")
    await svc.delete(db, project)


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
    project = await _load_project(db, project_id, user, "editor")
    if not blob_store.exists(body.sha):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Uploaded file not found")
    return await svc.update(
        db, project,
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
    project = await _load_project(db, project_id, user, "viewer")
    if not project.raw_file_sha or not blob_store.exists(project.raw_file_sha):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No source file")
    fsd = project.file_source_data or {}
    column_mapping = fsd.get("columnMapping", {})
    parse_options = fsd.get("parseOptions", {})
    select_sql = build_source_concepts_select(column_mapping)
    path = str(blob_store.path_for(project.raw_file_sha))
    try:
        rows = await asyncio.to_thread(
            db_connect.query_file_source,
            path, project.raw_file_name, parse_options, select_sql, body.sql,
        )
    except file_reader.ExcelSupportUnavailable:
        raise HTTPException(
            status.HTTP_501_NOT_IMPLEMENTED, "excel_support_unavailable"
        )
    except Exception as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Query failed: {e}")
    return rows


class FileColumnsPreview(CamelModel):
    sha: str
    file_name: str
    parse_options: dict | None = None


@router.post(_PROJ + "/preview-columns")
async def preview_file_columns(
    body: FileColumnsPreview,
    user: User = Depends(get_current_user),
):
    """Columns + row count of an already-uploaded blob, before a project exists.
    Lets the create dialog map columns of a file whose headers can't be read in
    the browser (Parquet in server mode) without booting DuckDB-WASM."""
    if not blob_store.exists(body.sha):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Uploaded file not found")
    path = str(blob_store.path_for(body.sha))
    try:
        cols, total = await asyncio.to_thread(
            db_connect.file_source_columns, path, body.file_name, body.parse_options,
        )
    except file_reader.ExcelSupportUnavailable:
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "excel_support_unavailable")
    except Exception as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Preview failed: {e}")
    return {"columns": cols, "rowCount": total}


def _project_to_dict(p: MappingProject) -> dict:
    return {
        "id": p.id, "name": p.name, "source_type": p.source_type,
        "updated_at": p.updated_at, "badges": p.badges,
        "raw_file_sha": p.raw_file_sha, "raw_file_name": p.raw_file_name,
        "file_source_data": p.file_source_data, "data_source_id": p.data_source_id,
    }


def _mapping_to_dict(m: ConceptMapping) -> dict:
    return {
        "id": m.id, "source_vocabulary_id": m.source_vocabulary_id,
        "source_concept_code": m.source_concept_code,
        "source_concept_name": m.source_concept_name,
        "source_concept_id": m.source_concept_id,
        "target_vocabulary_id": m.target_vocabulary_id,
        "target_concept_id": m.target_concept_id,
        "target_concept_name": m.target_concept_name,
        "equivalence": m.equivalence, "status": m.status,
        "mapped_by": m.mapped_by, "reviews": m.reviews,
        "created_at": m.created_at, "updated_at": m.updated_at,
    }


class GlobalTableQuery(CamelModel):
    workspace_id: str
    mode: str = "flat"  # 'flat' (project) | 'dedup' (badge)
    filters: dict = {}
    sort: dict | None = None
    limit: int = 50
    offset: int = 0


@router.post(_PROJ + "/global-table")
async def global_table(
    body: GlobalTableQuery,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """One page of the cross-project overview Table, merged + paginated
    server-side (source concepts + mappings + assigned-id registry). Replaces the
    browser's DuckDB-WASM temp table in fullstack mode."""
    await check_workspace_role(db, body.workspace_id, user, "viewer")
    mode = body.mode if body.mode in ("flat", "dedup") else "flat"

    projects = await svc.list_for_workspace(db, body.workspace_id)
    project_dicts = [_project_to_dict(p) for p in projects]
    mappings_by_project = {
        p.id: [_mapping_to_dict(m) for m in await svc.list_mappings(db, p.id)]
        for p in projects
    }
    entries = await sci_svc.list_entries(db, body.workspace_id)
    registry = {f"{e.vocabulary_id}__{e.concept_code}": e.source_concept_id for e in entries}

    def _run():
        path = global_table_service.get_or_build_cache(
            body.workspace_id, mode, project_dicts, mappings_by_project, registry,
        )
        return global_table_service.query_page(
            path, mode, body.filters, body.sort, body.limit, body.offset,
        )

    try:
        rows, total = await asyncio.to_thread(_run)
    except file_reader.ExcelSupportUnavailable:
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "excel_support_unavailable")
    except Exception as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Global table failed: {e}")
    return {"rows": rows, "total": total}


@router.get(_PROJ + "/{project_id}/raw-file")
async def get_raw_file(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await _load_project(db, project_id, user, "viewer")
    if not project.raw_file_sha or not blob_store.exists(project.raw_file_sha):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No source file")
    data = await blob_store.read_bytes(project.raw_file_sha)
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"x-file-name": project.raw_file_name or "source.csv"},
    )


# --- Concept mappings (per-project) ----------------------------------------

@router.get(_PROJ + "/{project_id}/mappings", response_model=list[ConceptMappingResponse])
async def list_mappings(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_project(db, project_id, user, "viewer")
    return await svc.list_mappings(db, project_id)


@router.delete(_PROJ + "/{project_id}/mappings", status_code=status.HTTP_204_NO_CONTENT)
async def delete_mappings_for_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_project(db, project_id, user, "editor")
    await svc.delete_mappings_for_project(db, project_id)


@router.post(_MAP, response_model=ConceptMappingResponse, status_code=status.HTTP_201_CREATED)
async def create_mapping(
    body: ConceptMappingCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_project(db, body.project_id, user, "editor")
    return await svc.create_mapping(db, body)


@router.post(_MAP + "/batch", status_code=status.HTTP_204_NO_CONTENT)
async def create_mappings_batch(
    body: ConceptMappingBatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    for pid in {m.project_id for m in body.mappings}:
        await _load_project(db, pid, user, "editor")
    await svc.create_mappings_batch(db, body.mappings)


@router.post(_MAP + "/delete-by-projects", status_code=status.HTTP_204_NO_CONTENT)
async def delete_by_projects(
    body: ConceptMappingDeleteByProjects,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    for pid in body.project_ids:
        await _load_project(db, pid, user, "editor")
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
    mapping = await _load_mapping(db, mapping_id, user, "editor")
    return await svc.update_mapping(db, mapping, body)


@router.delete(_MAP + "/{mapping_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_mapping(
    mapping_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    mapping = await _load_mapping(db, mapping_id, user, "editor")
    await svc.delete_mapping(db, mapping)


# --- Service mappings ------------------------------------------------------

@router.get(_SVC, response_model=list[ServiceMappingResponse])
async def list_service_mappings(
    workspace_id: str | None = Query(default=None, alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if workspace_id is not None:
        await check_workspace_role(db, workspace_id, user, "viewer")
        return await svc.list_service_mappings_for_workspace(db, workspace_id)
    mappings = await svc.list_service_mappings_all(db)
    visible: list[ServiceMapping] = []
    for m in mappings:
        try:
            await check_workspace_role(db, m.workspace_id, user, "viewer")
            visible.append(m)
        except HTTPException:
            continue
    return visible


@router.post(_SVC, response_model=ServiceMappingResponse, status_code=status.HTTP_201_CREATED)
async def create_service_mapping(
    body: ServiceMappingCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_role(db, body.workspace_id, user, "editor")
    return await svc.create_service_mapping(db, body)


@router.get(_SVC + "/{mapping_id}", response_model=ServiceMappingResponse)
async def get_service_mapping(
    mapping_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load_service_mapping(db, mapping_id, user, "viewer")


@router.patch(_SVC + "/{mapping_id}", response_model=ServiceMappingResponse)
async def update_service_mapping(
    mapping_id: str,
    body: ServiceMappingUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    mapping = await _load_service_mapping(db, mapping_id, user, "editor")
    return await svc.update_service_mapping(db, mapping, body)


@router.delete(_SVC + "/{mapping_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_service_mapping(
    mapping_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    mapping = await _load_service_mapping(db, mapping_id, user, "editor")
    await svc.delete_service_mapping(db, mapping)
