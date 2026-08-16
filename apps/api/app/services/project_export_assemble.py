"""Load a project's data and assemble its export ZIP bytes server-side.

The impure companion to ``project_export`` (which is pure): this reads the DB +
disk (project_fs) + blob store, shapes each entity into the camelCase dict the
frontend's Storage façade yields in server mode — in the SAME key order the API
emits (so the JSON is byte-identical) — then zips the resulting file tree.

Every ORM row is dumped through its ``XxxResponse`` schema
(``model_validate(...).model_dump(by_alias=True, mode="json")``) exactly like
``mapping_project_export_assemble``: full field set, ``None`` → ``null``, schema
field order preserved. Disk-derived entities (IDE scripts, datasets tree) are
shaped to match their server-mode API adapters (id === relative path for
datasets, synthetic ``scripts`` root for IDE files), because that is what the
frontend consumes.

The zip container mirrors ``git_service.clone_to_zip`` (io.BytesIO +
ZIP_DEFLATED). git versions the extracted files, so only the per-file contents
matter — the golden tests pin them. See docs/architecture.md ("Fullstack Storage & Compute").
"""

import asyncio
import io
import zipfile
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.datetime_format import normalize_iso_ms_z, to_iso_ms_z

from app.models.dataset import DatasetAnalysis
from app.models.project import Project
from app.schemas.cohort import CohortResponse
from app.schemas.dashboard import (
    DashboardResponse,
    DashboardTabResponse,
    DashboardWidgetResponse,
)
from app.schemas.dataset import DatasetAnalysisResponse
from app.schemas.ide_connection import IdeConnectionResponse
from app.schemas.pipeline import PipelineResponse
from app.schemas.project import ProjectResponse
from app.services import (
    attachment_service,
    blob_store,
    cohort_service,
    dashboard_service,
    ide_connection_service,
    pipeline_service,
    project_fs,
)
from app.services.data import dataset_fs
from app.services import concept_list_service
from app.schemas.concept_list import ConceptListResponse
from app.services.project_export import build_project_tree


def _read_env_specs(project_uid: str) -> dict[str, bytes]:
    """Read a project's managed-environment specs (manifest + lockfile) off disk as
    ``{"environments/<lang>/<file>": bytes}`` for the export tree. Only the spec is
    versioned — the materialised venv/library under .cache/ is skipped. Empty when
    no managed env has been created."""
    specs: dict[str, bytes] = {}
    for language in ("python", "r"):
        spec_dir = project_fs.env_spec_dir(project_uid, language)
        if not spec_dir.exists():
            continue
        for entry in sorted(spec_dir.iterdir()):
            if entry.is_file():
                specs[f"environments/{language}/{entry.name}"] = entry.read_bytes()
    return specs


def _dump(schema, row) -> dict:
    """ORM row → the exact camelCase dict the API emits (all fields, None → null,
    schema field order). Feeding these to the pure builder reproduces the
    frontend's per-file bytes."""
    return schema.model_validate(row).model_dump(by_alias=True, mode="json")


def _ide_node(project_uid: str, node: dict) -> dict:
    """One code node as the frontend sees it in server mode (api/ide-files
    ``toIdeFile``): {id, projectUid, name, type, parentId, content, language,
    createdAt:''}. Content is read from the export CODE dir (scripts_dir, NOT the
    broad IDE working dir) so a broad ide_path never leaks datasets into scripts/.
    ``createdAt`` is empty (disk-derived); the builder drops it. Key order matches
    the adapter so scripts/_tree.json is byte-identical."""
    is_file = node["type"] == "file"
    content = None
    if is_file:
        content = project_fs.export_script_path(project_uid, node["path"]).read_text(encoding="utf-8")
    return {
        "id": node["id"],
        "projectUid": project_uid,
        "name": node["name"],
        "type": node["type"],
        "parentId": node["parentId"],
        "content": content,
        "language": node["language"],
        "createdAt": "",
    }


def _dataset_node(project_uid: str, node: dict) -> dict:
    """One datasets-tree node as the frontend sees it in server mode (api/datasets
    ``dsNodeToFile``): id === relative path, parentId === parent path. columns /
    rowCount are omitted when absent (the adapter maps null → undefined, which
    ``JSON.stringify`` drops). createdAt/updatedAt are '' (stripped by the builder)."""
    columns, row_count, parse_options = None, None, None
    if node["type"] == "file":
        try:
            res = dataset_fs.resolve_cache(project_uid, node["path"])
            columns, row_count, parse_options = res["columns"], res["rowCount"], res.get("parseOptions")
        except Exception:
            columns, row_count, parse_options = None, None, None
    path = node["path"]
    parent_path = path.rsplit("/", 1)[0] if "/" in path else None
    out: dict = {
        "id": path,
        "projectUid": project_uid,
        "name": node["name"],
        "type": node["type"],
        "parentId": parent_path,
        "path": path,
    }
    if columns is not None:
        out["columns"] = columns
    if row_count is not None:
        out["rowCount"] = row_count
    if parse_options is not None:
        out["parseOptions"] = parse_options
    out["createdAt"] = ""
    out["updatedAt"] = ""
    return out


def _analysis_dict(row: DatasetAnalysis) -> dict:
    """One analysis as the frontend sees it in server mode (api/datasets maps the
    DatasetAnalysisResponse and appends ``datasetFileId`` = its datasetPath)."""
    d = _dump(DatasetAnalysisResponse, row)
    d["datasetFileId"] = d["datasetPath"]
    return d


async def build_project_tree_from_db(
    db: AsyncSession,
    project: Project,
    organization: dict | None = None,
) -> dict[str, bytes]:
    """Assemble the export file tree for a project from DB + disk + blob store.

    ``organization`` is the inherited org to inline into project.json when the
    project has no snapshot of its own — mirrors ``attachEntityOrganization``'s
    fallback (entity's own org, else the parent workspace's). The workspace export
    passes its own org here; a standalone project export leaves it None and inlines
    only the project's own snapshot."""
    project_dict = _dump(ProjectResponse, project)

    pipelines = [
        _dump(PipelineResponse, p)
        for p in await pipeline_service.list_for_project(db, project.uid)
    ]
    cohorts = [
        _dump(CohortResponse, c)
        for c in await cohort_service.list_for_project(db, project.uid)
    ]
    concept_lists = [
        _dump(ConceptListResponse, cl)
        for cl in await concept_list_service.list_for_project(db, project.uid)
    ]
    connections = [
        _dump(IdeConnectionResponse, c)
        for c in await ide_connection_service.list_for_project(db, project.uid)
    ]

    dashboards = []
    for d in await dashboard_service.list_for_project(db, project.uid):
        tabs = await dashboard_service.list_tabs(db, d.id)
        widgets = []
        for tab in tabs:
            widgets.extend(await dashboard_service.list_widgets(db, tab.id))
        dashboards.append(
            {
                "dashboard": _dump(DashboardResponse, d),
                "tabs": [_dump(DashboardTabResponse, t) for t in tabs],
                "widgets": [_dump(DashboardWidgetResponse, w) for w in widgets],
            }
        )

    # Disk-derived trees (id === relative path), the shape the frontend consumes in
    # server mode. Resolve the bindings so the scans read the right server dirs. The
    # scripts export uses the CODE dir (scripts_dir), NOT the broad IDE working dir.
    project_fs.prime_binding(
        project.uid, project.ide_path, project.scripts_path, project.datasets_path
    )
    ide_files = [
        _ide_node(project.uid, n)
        for n in await asyncio.to_thread(project_fs.scan_scripts_for_export, project.uid)
    ]
    ds_nodes = await asyncio.to_thread(project_fs.scan_datasets, project.uid)
    dataset_files = [_dataset_node(project.uid, n) for n in ds_nodes]

    analyses_res = await db.execute(
        select(DatasetAnalysis).where(DatasetAnalysis.project_uid == project.uid)
    )
    dataset_analyses: dict[str, list[dict]] = {}
    for row in analyses_res.scalars().all():
        dataset_analyses.setdefault(row.dataset_path, []).append(_analysis_dict(row))

    # A data file leaves the machine only when marked for versioning
    # (project.config.versionedDataFiles). Row data is never shipped by the
    # server-mode datasetData adapter (rows are paginated on demand), so it stays
    # empty — the export writes the raw file verbatim, without a _data.json sidecar
    # (matches the front's server-mode behavior). Raw files are read from disk.
    raw_cfg = (project.config or {}).get("versionedDataFiles")
    versioned_data_files: set[str] = set(
        p for p in raw_cfg if isinstance(p, str)
    ) if isinstance(raw_cfg, list) else set()
    # Code files are versioned by default; excludedFiles opts a script OUT so it's
    # omitted from the tree entirely (mirrors buildProjectZip / the sidebar badge).
    raw_excl = (project.config or {}).get("excludedFiles")
    excluded_files: set[str] = set(
        p for p in raw_excl if isinstance(p, str)
    ) if isinstance(raw_excl, list) else set()
    dataset_data: dict[str, list[dict]] = {}
    dataset_raw_files: dict[str, dict] = {}
    for node in ds_nodes:
        if node["type"] != "file":
            continue
        path = node["path"]
        # Marking key is the logical datasets/<path> (single namespace with scripts/).
        if f"datasets/{path}" not in versioned_data_files:
            continue
        file_path = await asyncio.to_thread(project_fs.dataset_path, project.uid, path)
        if file_path.is_file():
            blob = await asyncio.to_thread(file_path.read_bytes)
            dataset_raw_files[path] = {
                "blob": blob,
                "fileName": path.rsplit("/", 1)[-1],
            }

    attachments = []
    attachment_blobs: dict[str, bytes] = {}
    for att in await attachment_service.list_readme_by_owner(db, "project", project.uid):
        attachments.append(
            {
                # Owner fields are deliberately absent: they are re-stamped from
                # context on import, so the export stays portable (mirrors
                # writeAttachmentFiles in entity-io.ts).
                "id": att.id,
                "fileName": att.file_name,
                "mimeType": att.mime_type,
                "fileSize": att.file_size,
                # created_at is a String column today (rides through _json as-is),
                # but normalize to ms+Z so a future migration to DateTime can't emit
                # a raw datetime (TypeError in json.dumps) or a divergent format.
                "createdAt": (
                    to_iso_ms_z(att.created_at)
                    if isinstance(att.created_at, datetime)
                    else normalize_iso_ms_z(att.created_at)
                ),
            }
        )
        if att.blob_sha and blob_store.exists(att.blob_sha):
            attachment_blobs[att.id] = await blob_store.read_bytes(att.blob_sha)

    resolved_org = project.organization or organization

    return build_project_tree(
        env_specs=_read_env_specs(project.uid),
        project=project_dict,
        organization=resolved_org,
        ide_files=ide_files,
        pipelines=pipelines,
        cohorts=cohorts,
        concept_lists=concept_lists,
        connections=connections,
        dashboards=dashboards,
        dataset_files=dataset_files,
        dataset_analyses=dataset_analyses,
        dataset_data=dataset_data,
        dataset_raw_files=dataset_raw_files,
        attachments=attachments,
        attachment_blobs=attachment_blobs,
        versioned_data_files=versioned_data_files,
        excluded_files=excluded_files,
    )


def _zip_tree(tree: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path, content in tree.items():
            zf.writestr(path, content)
    return buf.getvalue()


async def assemble_project_zip(db: AsyncSession, project: Project) -> bytes:
    """Build the project's export ZIP bytes server-side (no client upload). Feeds
    the same git flow (status/diff/commit-push) that used to receive the
    client-built ZIP. Data-file inclusion follows project.config.versionedDataFiles."""
    tree = await build_project_tree_from_db(db, project)
    return await asyncio.to_thread(_zip_tree, tree)
