"""Load a workspace's data and assemble its export ZIP bytes server-side.

The impure companion to ``workspace_export`` (which is pure): this reads the DB +
disk + blob store, shapes each entity into the camelCase dict the frontend's
Storage façade yields in server mode — in the SAME key order the API emits (so the
JSON is byte-identical) — then zips the resulting file tree.

Every ORM row is dumped through its ``XxxResponse`` schema
(``model_validate(...).model_dump(by_alias=True, mode="json")``), exactly like the
project/mapping-project assemblers: full field set, ``None`` → ``null``, schema
field order preserved. The two heavy sections (unlinked-with-data projects and full
mapping projects) reuse ``build_project_tree_from_db`` and the standalone mapping
builder — the pure workspace builder just nests each sub-tree under
``projects/<folder>/`` and ``mapping-projects/<folder>/``.

The zip container mirrors ``git_service.clone_to_zip`` (io.BytesIO + ZIP_DEFLATED).
git versions the extracted files, so only the per-file contents matter — the golden
tests pin them. See docs/architecture.md ("Fullstack Storage & Compute").
"""

import asyncio
import io
import json
import re
import zipfile
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.mapping_project import MappingProject
from app.models.project import Project
from app.models.workspace import Workspace
from app.schemas.data_catalog import DataCatalogResponse
from app.schemas.data_source import DataSourceResponse
from app.schemas.dq_rule_set import DqCustomCheckResponse, DqRuleSetResponse
from app.schemas.etl_pipeline import EtlFileResponse, EtlPipelineResponse
from app.schemas.mapping_project import MappingProjectResponse, ServiceMappingResponse
from app.schemas.organization import OrganizationResponse
from app.schemas.project import ProjectResponse
from app.schemas.schema_preset import SchemaPresetResponse
from app.schemas.source_concept_id import SourceConceptIdRangeResponse
from app.schemas.sql_script import SqlScriptCollectionResponse, SqlScriptFileResponse
from app.schemas.user_plugin import UserPluginResponse
from app.schemas.attachment import WikiAttachmentResponse
from app.services.project_export import _gitignore_escape, _is_data_ext
from app.schemas.wiki_page import WikiPageResponse
from app.schemas.workspace import WorkspaceResponse
from app.services import (
    attachment_service,
    blob_store,
    data_catalog_service,
    data_source_service,
    dq_rule_set_service,
    etl_pipeline_service,
    mapping_project_service,
    organization_service,
    schema_preset_service,
    source_concept_id_service,
    sql_script_service,
    user_plugin_service,
    wiki_page_service,
)
from app.services.mapping_project_export import build_mapping_project_tree
from app.services.org_snapshot import resolve_entity_org_snapshot
from app.services.mapping_project_export_assemble import (
    _entry_dict,
    _mapping_dict,
    _project_dict,
    _range_dict,
)
from app.services.project_export_assemble import build_project_tree_from_db
from app.services.source_concept_id_scope import scoped_source_concept_ids
from app.services.workspace_export import (
    _eid,
    _json,
    _localized_en,
    _slugify,
    _strip_instance_fields,
    build_workspace_tree,
    entity_doc_files,
    strip_entity_docs,
)


@dataclass
class WorkspaceExportOptions:
    """Mirrors the frontend ``BuildWorkspaceZipOptions``: section toggles (all on by
    default) and the per-entity exclude opt-out. Unlinked entities always export
    their full content; connection details are never exported; data files follow
    each entity's own per-file versioning marks."""

    sections: dict[str, bool] = field(default_factory=dict)
    exclude_entities: dict[str, bool] = field(default_factory=dict)

    def on(self, key: str) -> bool:
        return self.sections.get(key) is not False


def _dump(schema, row) -> dict:
    return schema.model_validate(row).model_dump(by_alias=True, mode="json")


def _badged_dump(schema, row) -> dict:
    """_dump for scopes whose client rows carry ``badges`` only once set (sql
    collections, ETL pipelines, DQ rule sets, data catalogs): the client export
    omits the absent field entirely (JSON.stringify skips undefined) while
    Pydantic always emits an explicit null — drop it for byte-parity. Projects
    and workspaces store the field explicitly, so their null must be kept."""
    data = _dump(schema, row)
    if data.get("badges") is None:
        data.pop("badges", None)
    return data


def _resolve_git_remote(cfg: dict | None) -> dict | None:
    """Port of ``resolveGitRemote`` (entity-io.ts:1374): a remote with a URL, else
    None. The legacy ``gitUrl`` field never reaches the server schemas, so only the
    ``gitRemoteConfig`` branch applies."""
    if cfg and cfg.get("url"):
        return cfg
    return None


def _utf16_key(node: dict) -> bytes:
    """Sort key reproducing JavaScript's string comparison, for byte-parity with the
    TS export builder.

    JS `<`/`>` on strings compares UTF-16 CODE UNITS; Python compares CODE POINTS.
    They diverge above the BMP: a surrogate pair (U+1F600 → 0xD83D…) sorts BELOW
    U+FFFD in JS but ABOVE it in Python. So a file named `😀.sql` next to a
    U+E000..U+FFFF sibling would order differently in the two builders → different
    `_tree.json` bytes → a spurious git diff between a front-only and a server export
    of the same project. Encoding to UTF-16 big-endian makes Python order by code
    unit, exactly like JS."""
    return node["path"].encode("utf-16-be")


def _tree_path(file: dict, by_id: dict[str, dict]) -> str:
    """Port of ``treeNodePath`` (entity-tree.ts): reconstruct a tree node's path
    from its parent-name chain. Stops on a dangling or cyclic parent."""
    parts = [file["name"]]
    seen = {file["id"]}
    current = file
    while current.get("parentId"):
        parent = by_id.get(current["parentId"])
        if not parent or parent["id"] in seen:
            break
        seen.add(parent["id"])
        parts.insert(0, parent["name"])
        current = parent
    return "/".join(parts)


def _to_path_tree(files: list[dict], fk_key: str) -> list[dict]:
    """Port of ``toPathTree`` (entity-tree.ts): a node's identity in the repo is
    its path, so ``path`` replaces id/parentId/name and the instance-local FK
    (collectionId/pipelineId) and content are dropped. Sorted by path so the
    bytes never depend on the DB's insertion order (``list_files`` has no
    ORDER BY). Key order must match the TS builder — the golden fixtures are
    shared by both test suites."""
    by_id = {f["id"]: f for f in files}
    dropped = {"id", "parentId", "name", "content", fk_key}
    out = [
        {"path": _tree_path(f, by_id), **{k: v for k, v in f.items() if k not in dropped}}
        for f in files
    ]
    return sorted(out, key=_utf16_key)


def _to_portable_ranges(ranges: list[dict]) -> list[dict]:
    """Port of ``toPortableRanges`` (source-concept-ids-io.ts:197): keep the
    allocation subset in that key order, sort by badgeLabel (code-point order)."""
    out = [
        {
            "badgeLabel": r["badgeLabel"],
            "rangeStart": r["rangeStart"],
            "rangeEnd": r["rangeEnd"],
            "nextId": r["nextId"],
            "totalConcepts": r["totalConcepts"],
        }
        for r in ranges
    ]
    out.sort(key=lambda r: r["badgeLabel"])
    return out


# --- projects ---------------------------------------------------------------


async def _list_workspace_projects(db: AsyncSession, workspace_id: str) -> list[Project]:
    result = await db.execute(select(Project).where(Project.workspace_id == workspace_id))
    return list(result.scalars().all())


def _project_folder(project: Project) -> str:
    """Port of ``folder = project.projectId || slugify(resolveProjectName)``."""
    return project.project_id or _slugify(_localized_en(project.name) or "project")


async def _projects_section(
    db: AsyncSession,
    workspace_id: str,
    opts: "WorkspaceExportOptions",
    workspace_org: dict | None,
) -> list[dict]:
    entries: list[dict] = []
    for project in await _list_workspace_projects(db, workspace_id):
        if opts.exclude_entities.get(project.uid):
            continue
        git = _resolve_git_remote(project.git_remote_config)
        entry: dict = {
            "meta": _dump(ProjectResponse, project),
            "git": git,
            "folder": _project_folder(project),
            "readme": project.readme,
        }
        if not git:
            # The full nested tree inlines the inherited org into project.json, like
            # buildProjectZip's attachEntityOrganization fallback (project's own org,
            # else the parent workspace's). Data files follow each project's own
            # versionedDataFiles marking (read inside build_project_tree_from_db).
            entry["sub_tree"] = await build_project_tree_from_db(
                db, project, organization=workspace_org
            )
        entries.append(entry)
    return entries


# --- mapping projects -------------------------------------------------------


def _clean_mapping_meta(project: MappingProject) -> dict:
    """cleanMappingProjectMeta WITHOUT the inlined organization (the workspace
    factors the org into its root organization.json). The standalone mapping
    builder's project.json IS that clean form when given ``organization=None``, so
    reuse it and lift the file out rather than re-implementing the strip logic."""
    tree = build_mapping_project_tree(
        project=_project_dict(project),
        mappings=[],
        ranges=[],
        entries=[],
        organization=None,
        source_csv=None,
    )
    return json.loads(tree["project.json"].decode("utf-8"))


async def _mapping_project_sub_tree(db: AsyncSession, project: MappingProject) -> dict[str, bytes]:
    """The full mapping-project folder as it appears INSIDE a workspace export:
    project.json (clean, NO inlined organization) + mappings.json +
    source-concepts.csv + source-concept-ids/. Reuses the standalone mapping builder,
    then drops its standalone ``.gitignore`` — the workspace mapping folder never
    carries one (buildMappingProjectFolder omits it; the root .gitignore is not
    written in the workspace variant either)."""
    mappings = [
        _mapping_dict(m) for m in await mapping_project_service.list_mappings(db, project.id)
    ]
    ranges, entries, all_badge_entries = await scoped_source_concept_ids(db, project)

    source_csv = None
    if (
        project.source_type == "file"
        and project.raw_file_sha
        and blob_store.exists(project.raw_file_sha)
    ):
        source_csv = await blob_store.read_bytes(project.raw_file_sha)

    tree = build_mapping_project_tree(
        project=_project_dict(project),
        mappings=mappings,
        ranges=[_range_dict(r, all_badge_entries) for r in ranges],
        entries=[_entry_dict(e) for e in entries],
        organization=None,
        source_csv=source_csv,
    )
    tree.pop(".gitignore", None)
    return tree


async def _mapping_projects_section(
    db: AsyncSession, workspace_id: str, opts: "WorkspaceExportOptions"
) -> tuple[list[dict], list[dict]]:
    """Returns (mapping-project entries, portable workspace ranges)."""
    entries: list[dict] = []
    for mp in await mapping_project_service.list_for_workspace(db, workspace_id):
        if opts.exclude_entities.get(mp.id):
            continue
        git = _resolve_git_remote(mp.git_remote_config)
        mp_dict = _dump(MappingProjectResponse, mp)
        entry: dict = {
            "meta": _clean_mapping_meta(mp),
            "git": git,
            "folder": _eid(mp_dict),
            "id": mp.id,
            "entityId": mp_dict.get("entityId"),
            "name": mp_dict.get("name"),
        }
        if not git:
            entry["sub_tree"] = await _mapping_project_sub_tree(db, mp)
        entries.append(entry)

    ranges = await source_concept_id_service.list_ranges(db, workspace_id)
    id_ranges = _to_portable_ranges(
        [_dump(SourceConceptIdRangeResponse, r) for r in ranges]
    )
    return entries, id_ranges


# --- per-entity documentation (README / LICENSE / attachments) --------------


async def _readme_attachment_files(
    db: AsyncSession, prefix: str, owner_type: str, owner_id: str
) -> dict[str, bytes]:
    """Server equivalent of ``writeAttachmentFiles`` (entity-io.ts): the owner's
    README images as ``attachments/_meta.json`` (exactly the five portable keys —
    the owner fields are re-stamped from context on import) plus one file per blob."""
    attachments = await attachment_service.list_readme_by_owner(db, owner_type, owner_id)
    if not attachments:
        return {}
    tree: dict[str, bytes] = {
        f"{prefix}attachments/_meta.json": _json(
            [
                {
                    "id": att.id,
                    "fileName": att.file_name,
                    "mimeType": att.mime_type,
                    "fileSize": att.file_size,
                    "createdAt": att.created_at,
                }
                for att in attachments
            ]
        )
    }
    for att in attachments:
        if att.blob_sha and blob_store.exists(att.blob_sha):
            tree[f"{prefix}attachments/{att.id}-{att.file_name}"] = (
                await blob_store.read_bytes(att.blob_sha)
            )
    return tree


def _is_entity_docs_file(path: str) -> bool:
    """Port of ``isEntityDocsFile`` (entity-io.ts): the docs files the export owns."""
    lower = path.lower()
    return (
        bool(re.fullmatch(r"readme(\.[a-z-]+)?\.md", lower))
        or lower == "license.md"
        or path.startswith("attachments/")
    )


async def _entity_docs(
    db: AsyncSession, prefix: str, meta: dict, owner_type: str, owner_id: str
) -> dict[str, bytes]:
    """Server equivalent of ``writeEntityDocs`` (entity-io.ts): README.md (+ per
    language siblings), LICENSE.md, and the README attachments."""
    tree = entity_doc_files(prefix, meta)
    tree.update(await _readme_attachment_files(db, prefix, owner_type, owner_id))
    return tree


# --- sql / etl full folders -------------------------------------------------


async def _sql_collection_sub_tree(db: AsyncSession, collection) -> dict[str, bytes]:
    """Server equivalent of ``buildSqlCollectionFolder`` (entity-io.ts:1404):
    _collection.json (stripped) + _tree.json (files without content) + each file at
    its real path."""
    tree: dict[str, bytes] = {}
    dumped = _badged_dump(SqlScriptCollectionResponse, collection)
    tree["_collection.json"] = _json(strip_entity_docs(_strip_instance_fields(dumped)))
    tree.update(await _entity_docs(db, "", dumped, "sql-collection", collection.id))
    files = [
        _dump(SqlScriptFileResponse, f)
        for f in await sql_script_service.list_files(db, collection.id)
    ]
    by_id = {f["id"]: f for f in files}
    tree["_tree.json"] = _json(_to_path_tree(files, "collectionId"))
    for f in files:
        if f["type"] == "file" and f.get("content") is not None:
            tree[_tree_path(f, by_id)] = str(f["content"]).encode("utf-8")
    return tree


async def _etl_pipeline_sub_tree(db: AsyncSession, pipeline) -> dict[str, bytes]:
    """Server equivalent of ``buildEtlPipelineFolder`` (entity-io.ts:1775):
    _pipeline.json (stripped) + _tree.json + each file at its real path."""
    tree: dict[str, bytes] = {}
    dumped = _badged_dump(EtlPipelineResponse, pipeline)
    # Same byte-parity rule as `badges`: the client omits an unset `config`
    # entirely (JSON.stringify skips undefined) while Pydantic emits an explicit
    # null. A pipeline with no versioning marks must export identically either way.
    if dumped.get("config") is None:
        dumped.pop("config", None)
    tree["_pipeline.json"] = _json(
        strip_entity_docs(_strip_instance_fields(dumped))
    )
    tree.update(await _entity_docs(db, "", dumped, "etl-pipeline", pipeline.id))
    files = [
        _dump(EtlFileResponse, f)
        for f in await etl_pipeline_service.list_files(db, pipeline.id)
    ]
    by_id = {f["id"]: f for f in files}

    # Per-file versioning marks (pipeline.config), mirroring buildEtlPipelineFolder:
    # a file that does not leave the machine is dropped from the tree as well as
    # from the zip. A _tree.json naming a file the repo cannot contain breaks
    # re-import — it created an empty mapping/source_to_concept_map.csv — and made
    # every pull offer the phantom as an incoming change.
    config = getattr(pipeline, "config", None) or {}
    excluded = set(config.get("excludedFiles") or [])
    marked = set(config.get("versionedDataFiles") or [])

    def _is_versioned(path: str) -> bool:
        if _is_data_ext(path):
            return path in marked
        return path not in excluded

    kept = [
        f
        for f in files
        if f["type"] != "file" or _is_versioned(_tree_path(f, by_id))
    ]
    tree["_tree.json"] = _json(_to_path_tree(kept, "pipelineId"))
    for f in kept:
        if f["type"] == "file" and f.get("content") is not None:
            tree[_tree_path(f, by_id)] = str(f["content"]).encode("utf-8")
    return tree


# --- plugins ----------------------------------------------------------------


def _plugin_manifest_id(plugin_dict: dict) -> str | None:
    """Port of ``pluginManifestId`` (entity-io.ts:1808): the ``id`` from the bundled
    plugin.json manifest, else None."""
    try:
        return json.loads(plugin_dict.get("files", {}).get("plugin.json", "{}")).get("id")
    except (ValueError, AttributeError):
        return None


async def _exportable_plugins(db: AsyncSession, workspace_id: str) -> list[dict]:
    """Workspace plugins that are NOT copies of a built-in (mirrors the frontend
    filter in buildWorkspaceZip: built-ins are reconstitutable from the app's plugin
    registry on import, so their code is never bundled).

    The registry is a FRONTEND-only concept — the built-in components are compiled
    into the JS bundle (apps/web/src/lib/plugins/default-plugins.ts +
    builtin-widget-plugins.ts) and have no server-side representation. We reproduce
    the INTENT by matching the marker the seeder stamps on a built-in copy:
    ``seedBuiltinPlugins`` sets ``entityId === manifest.id`` and stores ONLY the
    manifest (+ optional analysis templates) as ``files`` — no user-authored code.
    A row is treated as a built-in (and skipped) when its files are exactly that
    seeded shape (plugin.json [+ analysis.*.template]) AND its entityId equals the
    manifest id. Any plugin carrying other files is user-authored and exported.

    This is an approximation of the frontend's registry lookup (see report note):
    it never drops a genuinely user-authored plugin, and skips the seeded built-in
    copies exactly as the frontend does for the shapes the seeder produces."""
    out: list[dict] = []
    for p in await user_plugin_service.list_for_workspace(db, workspace_id):
        d = _dump(UserPluginResponse, p)
        if _is_seeded_builtin(d):
            continue
        out.append(d)
    return out


def _is_seeded_builtin(plugin_dict: dict) -> bool:
    """A workspace plugin that is a seeded copy of an app built-in (see
    ``seedBuiltinPlugins``): entityId == manifest id, and files are only the
    manifest plus optional ``analysis.*.template`` companions — never user code."""
    files = plugin_dict.get("files") or {}
    if "plugin.json" not in files:
        return False
    if _plugin_manifest_id(plugin_dict) != plugin_dict.get("entityId"):
        return False
    return all(
        name == "plugin.json" or name.startswith("analysis.") for name in files
    )


# --- assembly ---------------------------------------------------------------


async def build_workspace_tree_from_db(
    db: AsyncSession, workspace: Workspace, options: WorkspaceExportOptions
) -> dict[str, bytes]:
    """Assemble the export file tree for a workspace from DB + disk + blob store."""
    workspace_dict = _dump(WorkspaceResponse, workspace)

    organization = None
    if workspace.organization_id:
        org = await organization_service.get(db, workspace.organization_id)
        if org:
            organization = _dump(OrganizationResponse, org)

    projects = (
        await _projects_section(db, workspace.id, options, organization)
        if options.on("projects")
        else None
    )

    wiki_pages = None
    wiki_attachments = None
    wiki_attachment_blobs: dict[str, bytes] = {}
    if options.on("wiki"):
        wiki_pages = [
            _dump(WikiPageResponse, p)
            for p in await wiki_page_service.list_for_workspace(db, workspace.id)
        ]
        wiki_attachments = []
        for att in await attachment_service.list_wiki_by_workspace(db, workspace.id):
            wiki_attachments.append(_dump(WikiAttachmentResponse, att))
            if att.blob_sha and blob_store.exists(att.blob_sha):
                wiki_attachment_blobs[att.id] = await blob_store.read_bytes(att.blob_sha)

    schemas = None
    if options.on("schemas"):
        schemas = []
        for sp in await schema_preset_service.list_for_workspace(db, workspace.id):
            # Keyed on `id` like every other section, matching what the client
            # sends (WsExportTab lists `id`). `preset_id` is still honoured so an
            # exclusion set by a client predating the split keeps working.
            if options.exclude_entities.get(sp.id) or options.exclude_entities.get(
                sp.preset_id
            ):
                continue
            schemas.append(
                {
                    "meta": strip_entity_docs(_dump(SchemaPresetResponse, sp)),
                    "git": _resolve_git_remote(sp.git_remote_config),
                }
            )

    data_sources = None
    if options.on("databases"):
        data_sources = []
        for ds in await data_source_service.list_for_workspace(db, workspace.id):
            if options.exclude_entities.get(ds.id):
                continue
            if ds.is_vocabulary_reference:
                continue
            data_sources.append(_dump(DataSourceResponse, ds))

    sql_collections = None
    if options.on("sqlScripts"):
        sql_collections = []
        for c in await sql_script_service.list_for_workspace(db, workspace.id):
            if options.exclude_entities.get(c.id):
                continue
            git = _resolve_git_remote(c.git_remote_config)
            meta = _badged_dump(SqlScriptCollectionResponse, c)
            entry: dict = {
                "meta": strip_entity_docs(meta),
                "git": git,
                "folder": _eid(meta),
            }
            if not git:
                entry["sub_tree"] = await _sql_collection_sub_tree(db, c)
            sql_collections.append(entry)

    etl_pipelines = None
    if options.on("etl"):
        etl_pipelines = []
        for p in await etl_pipeline_service.list_for_workspace(db, workspace.id):
            if options.exclude_entities.get(p.id):
                continue
            git = _resolve_git_remote(p.git_remote_config)
            meta = _badged_dump(EtlPipelineResponse, p)
            entry = {
                "meta": strip_entity_docs(meta),
                "git": git,
                "folder": _eid(meta),
            }
            if not git:
                entry["sub_tree"] = await _etl_pipeline_sub_tree(db, p)
            etl_pipelines.append(entry)

    dq_rule_sets = None
    if options.on("dataQuality"):
        dq_rule_sets = []
        for rs in await dq_rule_set_service.list_for_workspace(db, workspace.id):
            if options.exclude_entities.get(rs.id):
                continue
            checks = [
                _dump(DqCustomCheckResponse, c)
                for c in await dq_rule_set_service.list_checks(db, rs.id)
            ]
            meta = _badged_dump(DqRuleSetResponse, rs)
            dq_rule_sets.append(
                {
                    "meta": strip_entity_docs(meta),
                    "checks": checks,
                    "git": _resolve_git_remote(rs.git_remote_config),
                    "folder": _eid(meta),
                }
            )

    mapping_projects = None
    id_ranges = None
    if options.on("conceptMapping"):
        mapping_projects, id_ranges = await _mapping_projects_section(
            db, workspace.id, options
        )

    catalogs = None
    service_mappings = None
    if options.on("catalogs"):
        catalogs = []
        for cat in await data_catalog_service.list_for_workspace(db, workspace.id):
            if options.exclude_entities.get(cat.id):
                continue
            catalogs.append(
                {
                    "meta": strip_entity_docs(_badged_dump(DataCatalogResponse, cat)),
                    "git": _resolve_git_remote(cat.git_remote_config),
                }
            )
        service_mappings = []
        for sm in await mapping_project_service.list_service_mappings_for_workspace(
            db, workspace.id
        ):
            if options.exclude_entities.get(sm.id):
                continue
            service_mappings.append(_dump(ServiceMappingResponse, sm))

    plugins = None
    if options.on("plugins"):
        plugins = await _exportable_plugins(db, workspace.id)

    return build_workspace_tree(
        workspace=workspace_dict,
        organization=organization,
        projects=projects,
        wiki_pages=wiki_pages,
        wiki_attachments=wiki_attachments,
        wiki_attachment_blobs=wiki_attachment_blobs,
        readme_attachment_files=await _readme_attachment_files(
            db, "", "workspace", workspace.id
        ),
        schemas=schemas,
        data_sources=data_sources,
        sql_collections=sql_collections,
        etl_pipelines=etl_pipelines,
        dq_rule_sets=dq_rule_sets,
        mapping_projects=mapping_projects,
        id_ranges=id_ranges,
        catalogs=catalogs,
        service_mappings=service_mappings,
        plugins=plugins,
    )


def _zip_tree(tree: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path, content in tree.items():
            zf.writestr(path, content)
    return buf.getvalue()


async def assemble_workspace_zip(
    db: AsyncSession, workspace: Workspace, options: WorkspaceExportOptions
) -> bytes:
    """Build the workspace's export ZIP bytes server-side (no client upload). Feeds
    the same git flow (status/diff/commit-push) that used to receive the
    client-built ZIP."""
    tree = await build_workspace_tree_from_db(db, workspace, options)
    return await asyncio.to_thread(_zip_tree, tree)


# ---------------------------------------------------------------------------
# Standalone single-entity export trees (git push of one collection/pipeline/
# rule-set/catalog/preset/plugin). These mirror the frontend's build*Zip
# builders (entity-io.ts) — unlike the workspace sub-trees they INLINE the
# inherited organization as the last key of the metadata JSON (the workspace
# factors org into one root organization.json instead). No .gitattributes is
# written (the front's finalizeEntityZip only adds one when LFS overrides are
# present, which this server path doesn't take — matching the default export).
# ---------------------------------------------------------------------------


async def _attach_org(db: AsyncSession, tree: dict[str, bytes], meta_path: str, entity) -> None:
    """Port of attachEntityOrganization (entity-io.ts:1487): re-serialize the
    already-written metadata JSON with the resolved org snapshot appended as the
    last key. No-op when the entity resolves no org."""
    org = await resolve_entity_org_snapshot(db, entity)
    if org is None or meta_path not in tree:
        return
    meta = json.loads(tree[meta_path].decode("utf-8"))
    meta["organization"] = org
    tree[meta_path] = _json(meta)


async def build_sql_collection_tree(db: AsyncSession, collection) -> dict[str, bytes]:
    tree = await _sql_collection_sub_tree(db, collection)
    await _attach_org(db, tree, "_collection.json", collection)
    return tree


# Byte-faithful to buildEtlPipelineFolder's .gitignore (entity-io.ts), which uses
# DATA_FILE_EXTENSIONS. No `.cache/` and no `!path` exceptions: a standalone
# pipeline has no per-file versioning marks.
_DATA_FILE_GITIGNORE = b"**/*.csv\n**/*.parquet\n**/*.pq\n**/*.xlsx\n**/*.xls\n"

# Mirrors SCHEMA_PRESET_DDL_FILE in entity-io.ts.
SCHEMA_PRESET_DDL_FILE = "schema.ddl"


async def build_etl_pipeline_tree(db: AsyncSession, pipeline) -> dict[str, bytes]:
    tree = await _etl_pipeline_sub_tree(db, pipeline)
    # Standalone repo only (the workspace export's root .gitignore already covers
    # these). Matters most for mapping/*.csv: a mapping project's own dictionary,
    # kept out of the generated script precisely so it is not committed.
    #
    # A data file the user marked is re-included by a `!path` exception AFTER the
    # ignore rules — git honours the last match. Byte-faithful to
    # buildEtlPipelineFolder's block.
    config = getattr(pipeline, "config", None) or {}
    marked = [
        p
        for p in (config.get("versionedDataFiles") or [])
        if p in tree and _is_data_ext(p)
    ]
    lines = _DATA_FILE_GITIGNORE.decode("utf-8").rstrip("\n").split("\n")
    lines.extend(f"!{_gitignore_escape(p)}" for p in marked)
    tree[".gitignore"] = ("\n".join(lines) + "\n").encode("utf-8")
    await _attach_org(db, tree, "_pipeline.json", pipeline)
    return tree


async def build_dq_rule_set_tree(db: AsyncSession, rule_set) -> dict[str, bytes]:
    # Standalone layout (buildDqRuleSetFolder, entity-io.ts:1572): rule-set.json
    # (stripped) + checks.json (verbatim, only when non-empty). Note this differs
    # from the workspace layout, which bundles {ruleSet, checks} in _ruleset.json.
    tree: dict[str, bytes] = {}
    dumped = _badged_dump(DqRuleSetResponse, rule_set)
    tree["rule-set.json"] = _json(strip_entity_docs(_strip_instance_fields(dumped)))
    tree.update(await _entity_docs(db, "", dumped, "dq-rule-set", rule_set.id))
    checks = [_dump(DqCustomCheckResponse, c) for c in await dq_rule_set_service.list_checks(db, rule_set.id)]
    if checks:
        tree["checks.json"] = _json(checks)
    await _attach_org(db, tree, "rule-set.json", rule_set)
    return tree


async def build_data_catalog_tree(db: AsyncSession, catalog) -> dict[str, bytes]:
    tree: dict[str, bytes] = {}
    dumped = _badged_dump(DataCatalogResponse, catalog)
    tree["catalog.json"] = _json(strip_entity_docs(_strip_instance_fields(dumped)))
    tree.update(await _entity_docs(db, "", dumped, "data-catalog", catalog.id))
    await _attach_org(db, tree, "catalog.json", catalog)
    return tree


# Field order for an event table in an exported preset. Insertion order is the
# history of who edited what and when, so two instances holding the same mapping
# would emit different files and git would show a diff where nothing changed.
# Alphabetical would be stable but scatter the pairs (dateColumn far from
# endDateColumn), so the order is declared and grouped by meaning; unlisted keys
# are appended sorted. Mirrors EVENT_TABLE_FIELD_ORDER in entity-io.ts — both
# ends must emit identical bytes or the export golden tests fail.
_EVENT_TABLE_FIELD_ORDER = [
    "table",
    "conceptIdColumn",
    "sourceConceptIdColumn",
    "conceptVocabularyColumn",
    "conceptCodeColumn",
    "conceptDictionaryKey",
    "patientIdColumn",
    "dateColumn",
    "endDateColumn",
    "valueColumn",
    "valueStringColumn",
    "valueUnitColumn",
    "valueUnitConceptIdColumn",
    "routeColumn",
    "routeConceptIdColumn",
]


def _canonical_schema_mapping(mapping: dict) -> dict:
    """Mapping with its event tables (and their keys) in a deterministic order."""
    tables = mapping.get("eventTables")
    if not isinstance(tables, dict):
        return mapping
    ordered: dict = {}
    for label in sorted(tables):
        et = tables[label]
        if not isinstance(et, dict):
            ordered[label] = et
            continue
        rest = sorted(k for k in et if k not in _EVENT_TABLE_FIELD_ORDER)
        ordered[label] = {
            k: et[k] for k in [*_EVENT_TABLE_FIELD_ORDER, *rest] if k in et
        }
    return {**mapping, "eventTables": ordered}


async def build_schema_preset_tree(db: AsyncSession, preset) -> dict[str, bytes]:
    # The DDL is written as its own schema.ddl rather than inlined in preset.json:
    # see buildSchemaPresetFolder (entity-io.ts) for why. Both ends must emit the
    # same tree or git shows a false diff, so keep them in step.
    # _badged_dump, not _dump: the client omits an unset `badges` entirely while
    # Pydantic emits an explicit null, which would diff on every export.
    dumped = _badged_dump(SchemaPresetResponse, preset)
    # A preset that never got a lineage carries None on both keys; the client's
    # JSON.stringify omits them entirely, so emitting explicit nulls here would show
    # as a false git diff. Same rule as _badged_dump — and the same applies to
    # id/entityId, which a row written before that migration does not carry.
    for key in ("lineageId", "parentLineageId", "id", "entityId"):
        if dumped.get(key) is None:
            dumped.pop(key, None)
    stripped = strip_entity_docs(_strip_instance_fields(dumped))
    # Neither `id` nor `presetId` is exported — see buildSchemaPresetFolder for
    # both reasons: a preset is keyed on `entityId`, so an exported `id` never
    # survives an import, and `presetId` is the retired identity. `entityId`
    # leads the file, so it is placed at the front rather than assigned: a row
    # predating the split had it popped above as None, and re-adding it would
    # append it LAST — a false git diff on every export.
    entity_id = dumped.get("entityId") or preset.preset_id
    stripped.pop("id", None)
    stripped.pop("presetId", None)
    stripped = {"entityId": entity_id, **stripped}
    mapping = dict(stripped.get("mapping") or {})
    ddl = mapping.pop("ddl", None)
    stripped["mapping"] = _canonical_schema_mapping(mapping)
    tree: dict[str, bytes] = {"preset.json": _json(stripped)}
    if ddl:
        tree[SCHEMA_PRESET_DDL_FILE] = ddl.encode()
    # `organization` is stripped as an instance field, and every other entity puts
    # its provenance snapshot back. A preset did not, so each re-export silently
    # dropped the publishing organization from the repo.
    await _attach_org(db, tree, "preset.json", preset)
    tree.update(await _entity_docs(db, "", dumped, "schema-preset", preset.preset_id))
    return tree


async def build_user_plugin_tree(db: AsyncSession, plugin) -> dict[str, bytes]:
    # _plugin.json is a hand-built 4-key object (id/entityId/createdBy/
    # createdByDetails) + org last, mirroring buildUserPluginFolder (entity-io.ts:1622);
    # each source file is written at its raw filename. None-valued keys are dropped
    # to match JSON.stringify omitting undefined.
    p = _dump(UserPluginResponse, plugin)
    meta = {k: p[k] for k in ("id", "entityId", "createdBy", "createdByDetails") if p.get(k) is not None}
    tree: dict[str, bytes] = {"_plugin.json": _json(meta)}
    tree.update(await _entity_docs(db, "", p, "user-plugin", plugin.id))
    for filename, content in (plugin.files or {}).items():
        # README.md / LICENSE.md are the entity's own fields (written above); a
        # stale copy inside `files` would overwrite them.
        if _is_entity_docs_file(filename):
            continue
        tree[filename] = str(content).encode("utf-8")
    await _attach_org(db, tree, "_plugin.json", plugin)
    return tree


async def assemble_sql_collection_zip(db: AsyncSession, collection) -> bytes:
    return await asyncio.to_thread(_zip_tree, await build_sql_collection_tree(db, collection))


async def assemble_etl_pipeline_zip(db: AsyncSession, pipeline) -> bytes:
    return await asyncio.to_thread(_zip_tree, await build_etl_pipeline_tree(db, pipeline))


async def assemble_dq_rule_set_zip(db: AsyncSession, rule_set) -> bytes:
    return await asyncio.to_thread(_zip_tree, await build_dq_rule_set_tree(db, rule_set))


async def assemble_data_catalog_zip(db: AsyncSession, catalog) -> bytes:
    return await asyncio.to_thread(_zip_tree, await build_data_catalog_tree(db, catalog))


async def assemble_schema_preset_zip(db: AsyncSession, preset) -> bytes:
    return await asyncio.to_thread(_zip_tree, await build_schema_preset_tree(db, preset))


async def assemble_user_plugin_zip(db: AsyncSession, plugin) -> bytes:
    return await asyncio.to_thread(_zip_tree, await build_user_plugin_tree(db, plugin))
