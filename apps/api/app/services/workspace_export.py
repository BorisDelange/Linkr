"""Server-side builder for the workspace export tree — a byte-faithful Python
port of the frontend git-variant builder
(apps/web/src/lib/entity-io.ts ``buildWorkspaceZip``).

Returns the extracted ``{path: bytes}`` tree (NOT a zip container): git versions
the extracted files, and the container isn't byte-reproducible across JSZip and
Python ``zipfile``. A thin caller zips this tree for commit/push or download.

Parity matters: this MUST match the TS builder byte for byte, or a front-only
client and a server client versioning the same workspace repo produce false git
diffs. The shared golden fixture + twin tests
(apps/web/src/lib/__fixtures__/export-golden/workspace/,
apps/web/src/lib/workspace-export-golden.test.ts, and
apps/api/tests/test_workspace_export.py) guard this. See
docs/architecture.md ("Fullstack Storage & Compute") for the contract.

This is a PURE module: it takes already-loaded data (camelCase dicts + raw bytes
in the SAME shape/order the frontend's Storage façade yields in server mode) and
returns the file tree — the DB/disk/blob reads live in the caller
(workspace_export_assemble). Two heavy sections (unlinked-with-data projects and
full mapping projects) are supplied as ALREADY-BUILT sub-trees so this module
never re-implements those builders: the caller runs ``build_project_tree`` /
``build_mapping_project_tree`` and passes the result in.
"""

import unicodedata
from typing import Any

from app.core.json_export import export_json as _json
from app.services.export_layout import (
    ENTITY_MANIFEST,
    git_pointer_manifest,
    order_provenance,
    TYPE_DATA_CATALOG,
    TYPE_DQ_RULE_SET,
    TYPE_ETL_PIPELINE,
    TYPE_MAPPING_PROJECT,
    TYPE_PROJECT,
    TYPE_SCHEMA_PRESET,
    TYPE_SQL_COLLECTION,
    TYPE_WORKSPACE,
    with_entity_type,
)

# The export-format version stamped into workspace.json / project pointers
# (``appVersion``) — see app/export_version.py. It equals the frontend's
# version.ts APP_VERSION so front-only and server exports are byte-identical.
from app.export_version import EXPORT_APP_VERSION as APP_VERSION

# README.md / LICENSE.md / stripEntityDocs live in entity_docs: every documentable
# entity shares them, so they are not workspace-specific.
from app.services.entity_docs import (  # noqa: F401  (re-exported for the assemblers)
    entity_doc_files,
    license_meta,
    strip_entity_docs,
    to_localized as _to_localized,
)
from app.services.entity_docs import readme_files as _readme_files
from app.services.org_snapshot import org_snapshot

# Fields specific to the exporting instance/deployment, dropped from every
# exported entity's metadata — mirrors INSTANCE_FIELDS in
# apps/web/src/lib/entity-io.ts. ``createdAt`` is NOT here (portable provenance);
# only ``updatedAt`` moves on every edit, so it is dropped.
_INSTANCE_FIELDS = (
    "ownerId",
    "createdById",
    "origin",
    "workspaceId",
    "gitRemoteConfig",
    "gitUrl",
    "catalogVisibility",
    "organization",
    "organizationId",
    "updatedAt",
    "projectUid",
    "linkedDataSourceIds",
)


# _json is the shared export serializer (app/core/json_export.export_json):
# 2-space indent, ``": "``/``",\n`` separators, insertion-order keys, UTF-8, no
# trailing newline, and whole-valued floats emitted as ints (JS parity — a DQ
# threshold of 0/100 must serialize as ``0``/``100``, not ``0.0``/``100.0``).


def _slugify(name: str) -> str:
    """Port of ``slugify`` (packages/linkr-format/src/ids.ts)."""
    decomposed = unicodedata.normalize("NFD", name)
    # By category, like the TS twin's `\\p{Mn}` — see project_export._slugify.
    without_marks = "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
    lowered = without_marks.lower()
    out: list[str] = []
    prev_dash = False
    for ch in lowered:
        if ch.isascii() and ch.isalnum():
            out.append(ch)
            prev_dash = False
        elif not prev_dash:
            out.append("-")
            prev_dash = True
    slug = "".join(out).strip("-")
    return slug or "export"


def _localized_en(value: Any) -> str:
    """Port of ``localized(value, 'en')``: a bare string is returned as-is; a
    LocalizedString dict prefers ``en`` then the first truthy value."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        if value.get("en"):
            return value["en"]
        for v in value.values():
            if v:
                return v
    return ""


def _strip_instance_fields(meta: dict) -> dict:
    """Port of ``stripInstanceFields`` (entity-io.ts:417): copy, drop the
    instance-specific fields (preserving key order), then drop an empty
    ``createdAt``."""
    out = {k: v for k, v in meta.items() if k not in _INSTANCE_FIELDS}
    if not out.get("createdAt"):
        out.pop("createdAt", None)
    return out


def _eid(entity: dict) -> str:
    """Port of ``eid`` (entity-io.ts:1920): prefer entityId, else slugify the
    English name (or id, or 'unknown')."""
    if entity.get("entityId"):
        return entity["entityId"]
    return _slugify(_localized_en(entity.get("name")) or entity.get("id") or "unknown")


#: Mirrors ``EXPORTED_CONNECTION_KEYS`` (entity-io.ts). Order matters: both
#: builders emit the keys in this order, and the golden tests compare bytes.
_CONNECTION_CONFIG_EXPORTED = ("engine", "inMemory", "managed")


def _sanitize_connection_config(config: dict) -> dict:
    """Port of ``sanitizeConnectionConfig`` (entity-io.ts).

    An allowlist, deliberately: a denylist keeps whatever it was not taught to
    remove, so a config that grows an ``sslCert`` or ``apiKey`` would publish it
    silently. Hosts, ports, database and schema names, usernames, passwords,
    tokens and local file references never leave the machine.
    """
    return {k: config[k] for k in _CONNECTION_CONFIG_EXPORTED if config.get(k) is not None}


# --- git link manifest ------------------------------------------------------


class _GitLinks:
    """Accumulates git-linked entities, written as git-links.json at the end."""

    def __init__(self) -> None:
        self.links: list[dict] = []

    def add(self, kind: str, entity_id: str, folder: str, git: dict) -> None:
        self.links.append(
            {
                "type": kind,
                "id": entity_id,
                "folder": folder,
                "url": git["url"],
                "branch": git["branch"],
            }
        )


# --- section builders (each mutates ``tree``) -------------------------------


def _build_projects_section(
    tree: dict[str, bytes],
    projects: list[dict],
    git_links: _GitLinks,
) -> None:
    """Port of the projects/ section (entity-io.ts:1876-1916). Each project entry
    carries its resolved shape from the caller:
    ``{"meta": <project dict>, "git": <cfg|None>, "folder": str,
       "readme": <localized|None>, "sub_tree": <dict|None>}``.
    - git-linked → pointer project.json only + a git-links entry.
    - unlinked → the full project tree nested under ``projects/<folder>/``
      (built by the caller with build_project_tree).
    - unlinked with no sub_tree (defensive fallback) → lightweight
      project.json + README.
    Excludes are applied by the caller (absent from the list)."""
    for entry in projects:
        project = entry["meta"]
        git = entry.get("git")
        folder = entry["folder"]
        project_meta = {
            k: v for k, v in project.items() if k not in ("todos", "notes", "readme")
        }
        project_meta_out = _strip_instance_fields(project_meta)
        if git:
            project_meta_out["gitRemoteConfig"] = git
        project_meta_out["appVersion"] = APP_VERSION

        if git:
            # createdAt rides along so the pointer-create records the real creation
            # date (an absent createdAt makes the server stamp func.now()). Key order
            # mirrors buildWorkspaceZip's pointer for byte-parity.
            pointer = git_pointer_manifest(
                TYPE_PROJECT,
                uid=project.get("uid"),
                entity_id=project.get("entityId") or project.get("projectId"),
                name=project.get("name"),
                created_at=project.get("createdAt"),
                lineage_id=project.get("lineageId"),
                git=git,
            )
            tree[f"projects/{folder}/{ENTITY_MANIFEST}"] = _json(pointer)
            git_links.add("project", project["uid"], folder, git)
        elif entry.get("sub_tree") is not None:
            for path, content in entry["sub_tree"].items():
                tree[f"projects/{folder}/{path}"] = content
        else:
            tree[f"projects/{folder}/{ENTITY_MANIFEST}"] = _json(project_meta_out)
            tree.update(_readme_files(f"projects/{folder}/", entry.get("readme")))


def _build_wiki_section(
    tree: dict[str, bytes],
    wiki_pages: list[dict],
    wiki_attachments: list[dict],
    wiki_attachment_blobs: dict[str, bytes],
) -> None:
    """Port of the wiki/ section (entity-io.ts:1924-1954)."""
    if not wiki_pages:
        return
    tree["wiki/_tree.json"] = _json(
        [{k: v for k, v in p.items() if k != "content"} for p in wiki_pages]
    )
    for page in wiki_pages:
        page_folder = page.get("entityId") or (
            f"{_slugify(_localized_en(page.get('title')) or page['id'])}--{page['id']}"
        )
        content = _to_localized(page.get("content"))
        langs = [lang for lang in content if content[lang]]
        if not langs:
            tree[f"wiki/{page_folder}.md"] = b""
        else:
            primary = "en" if "en" in langs else langs[0]
            for lang in langs:
                suffix = "" if lang == primary else f".{lang}"
                tree[f"wiki/{page_folder}{suffix}.md"] = str(content[lang]).encode("utf-8")

    if wiki_attachments:
        tree["wiki/_attachments/_meta.json"] = _json(
            [{k: v for k, v in a.items() if k != "data"} for a in wiki_attachments]
        )
        for att in wiki_attachments:
            blob = wiki_attachment_blobs.get(att["id"])
            if blob is not None:
                tree[f"wiki/_attachments/{att['id']}-{att['fileName']}"] = blob


def _build_schemas_section(
    tree: dict[str, bytes], schemas: list[dict], git_links: _GitLinks
) -> None:
    """Port of the schemas/ section (entity-io.ts:1958-1985). ``git`` per entry.
    Git-linked → a MINIMAL pointer (identity + optional mapping.presetLabel + git
    pointer; the linked repo's preset.json is the source of truth).

    The folder is named after the readable slug, not the row's uuid: a human
    browses this tree. The git-links id is the entity key (`id`), matching the
    client — both ends must emit the same bytes or git shows a false diff."""
    for entry in schemas:
        sp = entry["meta"]
        git = entry.get("git")
        slug = sp.get("entityId") or sp["presetId"]
        if git:
            folder = _slugify(slug)
            mapping = sp.get("mapping") or {}
            pointer = git_pointer_manifest(
                TYPE_SCHEMA_PRESET,
                entity_id=slug,
                name=mapping.get("presetLabel"),
                created_at=sp.get("createdAt"),
                lineage_id=sp.get("lineageId"),
                git=git,
            )
            tree[f"schemas/{folder}/{ENTITY_MANIFEST}"] = _json(pointer)
            git_links.add("schema-preset", sp.get("id") or sp["presetId"], folder, git)
            continue
        tree[f"schemas/{_slugify(slug)}.json"] = _json(sp)


def _build_databases_section(
    tree: dict[str, bytes], data_sources: list[dict]
) -> None:
    """Port of the databases/ section (entity-io.ts). Vocabulary references are
    filtered out by the caller. connectionConfig is sanitized here — connection
    details and passwords never leave the machine."""
    for ds in data_sources:
        connection_config = ds.get("connectionConfig")
        rest = {k: v for k, v in ds.items() if k != "connectionConfig"}
        safe = {
            **rest,
            "connectionConfig": (
                _sanitize_connection_config(connection_config)
                if connection_config
                else None
            ),
        }
        # _eid, like every other section: prefers the stable entityId, so
        # renaming a database no longer moves its file and churns the git diff.
        tree[f"databases/{_eid(ds)}.json"] = _json(safe)


def _build_sql_scripts_section(
    tree: dict[str, bytes], collections: list[dict], git_links: _GitLinks
) -> None:
    """Port of the sql-scripts/ section (entity-io.ts). Each entry:
    ``{"meta": <collection>, "git": cfg|None, "folder": str,
       "sub_tree": <dict|None>}`` — the full-content sub-tree (built by the caller
    with ``buildSqlCollectionFolder``'s server equivalent) is present whenever the
    entity is unlinked."""
    for entry in collections:
        collection = entry["meta"]
        git = entry.get("git")
        folder = entry["folder"]
        if git:
            # createdAt rides along so the pointer-create records the real creation
            # date (an absent createdAt makes the server stamp func.now()). Omit when
            # absent for byte-parity with the TS builder.
            pointer = git_pointer_manifest(
                TYPE_SQL_COLLECTION,
                entity_id=_eid(collection),
                name=collection.get("name"),
                created_at=collection.get("createdAt"),
                lineage_id=collection.get("lineageId"),
                git=git,
            )
            tree[f"sql-scripts/{folder}/{ENTITY_MANIFEST}"] = _json(pointer)
            git_links.add("sql-collection", collection["id"], folder, git)
            continue
        if entry.get("sub_tree") is None:
            tree[f"sql-scripts/{folder}/{ENTITY_MANIFEST}"] = _json(collection)
            continue
        for path, content in entry["sub_tree"].items():
            tree[f"sql-scripts/{folder}/{path}"] = content


def _build_etl_section(
    tree: dict[str, bytes], pipelines: list[dict], git_links: _GitLinks
) -> None:
    """Port of the etl/ section (entity-io.ts:2022-2040)."""
    for entry in pipelines:
        pipeline = entry["meta"]
        git = entry.get("git")
        folder = entry["folder"]
        if git:
            # createdAt rides along so the pointer-create records the real creation
            # date (an absent createdAt makes the server stamp func.now()). Omit when
            # absent for byte-parity with the TS builder.
            pointer = git_pointer_manifest(
                TYPE_ETL_PIPELINE,
                entity_id=_eid(pipeline),
                name=pipeline.get("name"),
                created_at=pipeline.get("createdAt"),
                lineage_id=pipeline.get("lineageId"),
                git=git,
            )
            tree[f"etl/{folder}/{ENTITY_MANIFEST}"] = _json(pointer)
            git_links.add("etl-pipeline", pipeline["id"], folder, git)
            continue
        if entry.get("sub_tree") is None:
            tree[f"etl/{folder}/{ENTITY_MANIFEST}"] = _json(pipeline)
            continue
        for path, content in entry["sub_tree"].items():
            tree[f"etl/{folder}/{path}"] = content


def _build_data_quality_section(
    tree: dict[str, bytes], rule_sets: list[dict], git_links: _GitLinks
) -> None:
    """Port of the data-quality/ section (entity-io.ts:2044-2059). Each entry:
    ``{"meta": <ruleSet>, "checks": [...], "git": cfg|None, "folder": str}``. The
    file is the ``{ruleSet, checks}`` bundle."""
    for entry in rule_sets:
        rs = entry["meta"]
        checks = entry.get("checks", [])
        git = entry.get("git")
        folder = entry["folder"]
        if git:
            # Pointer only — the linked repo's rule-set.json + checks.json are the
            # source of truth; the clone re-applies metadata and checks. createdAt
            # rides along so the pointer-create records the real creation date (an
            # absent createdAt makes the server stamp func.now()). Omit when absent
            # for byte-parity with the TS builder.
            tree[f"data-quality/{folder}/{ENTITY_MANIFEST}"] = _json(
                git_pointer_manifest(
                    TYPE_DQ_RULE_SET,
                    entity_id=rs.get("entityId"),
                    name=rs.get("name"),
                    created_at=rs.get("createdAt"),
                    lineage_id=rs.get("lineageId"),
                    git=git,
                )
            )
            git_links.add("dq-rule-set", rs["id"], folder, git)
            continue
        tree[f"data-quality/{folder}.json"] = _json({"ruleSet": rs, "checks": checks})


def _build_concept_sets_section(tree: dict[str, bytes], concept_sets: list[dict]) -> None:
    """Port of the concept-sets/ section (entity-io.ts). Workspace-scoped imported
    data dictionaries. Metadata arrives already stripped from the caller."""
    for cs in concept_sets:
        slug = _slugify(cs.get("name") or cs["id"])
        tree[f"concept-sets/{slug}.json"] = _json(cs)


def _build_mapping_projects_section(
    tree: dict[str, bytes],
    mapping_projects: list[dict],
    id_ranges: list[dict],
    git_links: _GitLinks,
) -> None:
    """Port of the mapping-projects/ + workspace source-concept-ids/ranges.json
    sections (entity-io.ts:2063-2101). Each mapping-project entry:
    ``{"meta": <clean project.json dict>, "git": cfg|None, "folder": str, "id": str,
       "entityId": str|None, "name": <localized|str>, "sub_tree": <dict|None>}``.
    - git-linked → a MINIMAL pointer project.json (id/entityId/name + gitRemoteConfig
      — the linked repo's own project.json is the source of truth) + git link.
    - unlinked → the full folder (built by the caller with
      build_mapping_project_tree, WITHOUT its standalone .gitignore) nested here;
      a missing sub_tree (defensive fallback) emits the clean project.json only.
    ``id_ranges`` are the already-portable workspace ranges."""
    for entry in mapping_projects:
        clean_meta = entry["meta"]
        git = entry.get("git")
        folder = entry["folder"]
        if git:
            # createdAt rides along so the pointer-create records the real creation
            # date (an absent createdAt makes the server stamp func.now()). Omit when
            # absent for byte-parity with the TS builder.
            pointer = git_pointer_manifest(
                TYPE_MAPPING_PROJECT,
                entity_id=entry.get("entityId"),
                name=entry.get("name"),
                created_at=clean_meta.get("createdAt"),
                lineage_id=clean_meta.get("lineageId"),
                git=git,
            )
            tree[f"mapping-projects/{folder}/{ENTITY_MANIFEST}"] = _json(pointer)
            git_links.add("mapping-project", entry["id"], folder, git)
            continue
        if entry.get("sub_tree") is None:
            tree[f"mapping-projects/{folder}/{ENTITY_MANIFEST}"] = _json(clean_meta)
            continue
        for path, content in entry["sub_tree"].items():
            tree[f"mapping-projects/{folder}/{path}"] = content

    if id_ranges:
        tree["source-concept-ids/ranges.json"] = _json(id_ranges)


def _build_catalogs_section(
    tree: dict[str, bytes],
    catalogs: list[dict],
    service_mappings: list[dict],
    git_links: _GitLinks,
) -> None:
    """Port of the catalogs/ + service-mappings/ section (entity-io.ts:2105-2125)."""
    for entry in catalogs:
        cat = entry["meta"]
        git = entry.get("git")
        if git:
            folder = _eid(cat)
            # createdAt rides along so the pointer-create records the real creation
            # date (an absent createdAt makes the server stamp func.now()). Omit when
            # absent for byte-parity with the TS builder.
            pointer = git_pointer_manifest(
                TYPE_DATA_CATALOG,
                entity_id=_eid(cat),
                name=cat.get("name"),
                created_at=cat.get("createdAt"),
                lineage_id=cat.get("lineageId"),
                git=git,
            )
            tree[f"catalogs/{folder}/{ENTITY_MANIFEST}"] = _json(pointer)
            git_links.add("data-catalog", cat["id"], folder, git)
            continue
        tree[f"catalogs/{_eid(cat)}.json"] = _json(cat)

    for sm in service_mappings:
        # Stripped like every other section: the raw row leaked `workspaceId`
        # (this instance's) and `updatedAt` (churns on every edit).
        tree[f"service-mappings/{_slugify(sm.get('name') or sm['id'])}.json"] = _json(
            _strip_instance_fields(sm)
        )


def _build_plugins_section(tree: dict[str, bytes], plugins: list[dict]) -> None:
    """Port of the plugins/ section (entity-io.ts:2132-2143). Built-in plugins are
    filtered out by the caller (they're reconstitutable from the registry on
    import). Each entry is a userPlugin dict with a ``files`` dict."""
    for plugin in plugins:
        folder = plugin.get("entityId") or _slugify(plugin["id"])
        tree[f"plugins/{folder}/{ENTITY_MANIFEST}"] = _json(
            {
                "entityId": plugin.get("entityId"),
                "createdAt": plugin.get("createdAt"),
                "createdBy": plugin.get("createdBy"),
                "createdByDetails": plugin.get("createdByDetails"),
            }
        )
        for filename, content in (plugin.get("files") or {}).items():
            tree[f"plugins/{folder}/{filename}"] = str(content).encode("utf-8")


def build_workspace_tree(
    *,
    workspace: dict,
    organization: dict | None,
    projects: list[dict] | None,
    wiki_pages: list[dict] | None,
    wiki_attachments: list[dict] | None,
    wiki_attachment_blobs: dict[str, bytes] | None,
    # The workspace README's own images, already shaped as ``attachments/...`` paths
    # by the caller (they need a DB + blob-store read, which this pure module can't do).
    readme_attachment_files: dict[str, bytes] | None = None,
    schemas: list[dict] | None,
    data_sources: list[dict] | None,
    sql_collections: list[dict] | None,
    etl_pipelines: list[dict] | None,
    dq_rule_sets: list[dict] | None,
    mapping_projects: list[dict] | None,
    concept_sets: list[dict] | None,
    id_ranges: list[dict] | None,
    catalogs: list[dict] | None,
    service_mappings: list[dict] | None,
    plugins: list[dict] | None,
) -> dict[str, bytes]:
    """Build the git-variant workspace export tree as ``{path: bytes}``.

    Byte-faithful to ``buildWorkspaceZip``. A section arg being ``None`` means the
    section toggle is OFF (skipped entirely); an empty list means the section is on
    but has no entities. Heavy sub-trees (full projects, full mapping projects, full
    sql/etl collections) are pre-built and passed in per entity so this module never
    re-implements those builders. Excludes are applied by the caller. Order of file
    emission matches the TS builder (workspace.json, organization.json, README,
    projects, wiki, schemas, databases, sql, etl, data-quality, mapping-projects,
    catalogs, plugins, git-links.json).
    """
    tree: dict[str, bytes] = {}
    git_links = _GitLinks()

    ws_out = with_entity_type(
        _strip_instance_fields(strip_entity_docs(workspace)), TYPE_WORKSPACE
    )
    # A workspace is the container, not a published, versioned unit — `version` is
    # deliberately null rather than added to the model. `license` and the inline org
    # snapshot bring it in line with the other eight kinds; organization.json stays
    # below, carrying the full record the import upserts.
    ws_out["version"] = None
    licence = license_meta(workspace.get("license"))
    if licence is not None:
        ws_out["license"] = licence
    # Same guard as organization.json below (and as the client, which resolves the
    # org only when the workspace points at one): a stray `organization` without an
    # `organizationId` would diff between the two builders.
    has_org = bool(workspace.get("organizationId")) and organization is not None
    ws_out["organization"] = org_snapshot(organization) if has_org else None
    # appVersion last, after the provenance keys are ordered into place.
    ws_out = order_provenance(ws_out)
    ws_out["appVersion"] = APP_VERSION
    tree[ENTITY_MANIFEST] = _json(ws_out)

    if workspace.get("organizationId") and organization:
        # org_snapshot drops updatedAt and normalizes createdAt to ms+Z — the same
        # portable shape as the inline org snapshots, so this root org doesn't churn.
        tree["organization.json"] = _json(org_snapshot(organization))

    tree.update(entity_doc_files("", workspace))
    tree.update(readme_attachment_files or {})

    if projects is not None:
        _build_projects_section(tree, projects, git_links)
    if wiki_pages is not None:
        _build_wiki_section(
            tree, wiki_pages, wiki_attachments or [], wiki_attachment_blobs or {}
        )
    if schemas is not None:
        _build_schemas_section(tree, schemas, git_links)
    if data_sources is not None:
        _build_databases_section(tree, data_sources)
    if sql_collections is not None:
        _build_sql_scripts_section(tree, sql_collections, git_links)
    if etl_pipelines is not None:
        _build_etl_section(tree, etl_pipelines, git_links)
    if dq_rule_sets is not None:
        _build_data_quality_section(tree, dq_rule_sets, git_links)
    if concept_sets is not None:
        _build_concept_sets_section(tree, concept_sets)
    if mapping_projects is not None:
        _build_mapping_projects_section(
            tree, mapping_projects, id_ranges or [], git_links
        )
    if catalogs is not None:
        _build_catalogs_section(tree, catalogs, service_mappings or [], git_links)
    if plugins is not None:
        _build_plugins_section(tree, plugins)

    if git_links.links:
        # Sort deterministically so adding/removing an unrelated link never reorders
        # the rest and churns the versioning diff. Key is (type, id) — id is an
        # immutable UUID. Must match the TS export (entity-io.ts).
        links = sorted(git_links.links, key=lambda link: (link["type"], link["id"]))
        tree["git-links.json"] = _json({"appVersion": APP_VERSION, "links": links})

    return tree
