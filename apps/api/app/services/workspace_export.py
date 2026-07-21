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
docs/planning/server-export-plan.md §2/§8 for the contract.

This is a PURE module: it takes already-loaded data (camelCase dicts + raw bytes
in the SAME shape/order the frontend's Storage façade yields in server mode) and
returns the file tree — the DB/disk/blob reads live in the caller
(workspace_export_assemble). Two heavy sections (unlinked-with-data projects and
full mapping projects) are supplied as ALREADY-BUILT sub-trees so this module
never re-implements those builders: the caller runs ``build_project_tree`` /
``build_mapping_project_tree`` and passes the result in.
"""

import json
import unicodedata
from typing import Any

# The export-format version stamped into workspace.json / project pointers
# (``appVersion``) — see app/export_version.py. It equals the frontend's
# version.ts APP_VERSION so front-only and server exports are byte-identical.
from app.export_version import EXPORT_APP_VERSION as APP_VERSION
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


def _json(value: Any) -> bytes:
    """Serialize like TS ``JSON.stringify(x, null, 2)``: 2-space indent, ``": "``
    and ``",\\n"`` separators, insertion-order keys (never sorted), UTF-8, no
    trailing newline."""
    return json.dumps(
        value, indent=2, ensure_ascii=False, separators=(",", ": ")
    ).encode("utf-8")


def _slugify(name: str) -> str:
    """Port of ``slugify`` (entity-io.ts:143)."""
    decomposed = unicodedata.normalize("NFD", name)
    without_marks = "".join(c for c in decomposed if not unicodedata.combining(c))
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


def _to_localized(value: Any) -> dict:
    """Port of ``toLocalized``: dict stays, a non-empty string becomes
    ``{'en': value}``, empty/None becomes ``{}``."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        return {"en": value}
    return {}


def _strip_instance_fields(meta: dict) -> dict:
    """Port of ``stripInstanceFields`` (entity-io.ts:417): copy, drop the
    instance-specific fields (preserving key order), then drop an empty
    ``createdAt``."""
    out = {k: v for k, v in meta.items() if k not in _INSTANCE_FIELDS}
    if not out.get("createdAt"):
        out.pop("createdAt", None)
    return out


def _readme_files(prefix: str, readme: Any) -> dict[str, bytes]:
    """Port of ``writeReadmeFiles`` (entity-io.ts:35): ``README.md`` for the
    primary language (en, else first), ``README.<lang>.md`` for the rest, written
    at ``<prefix>``."""
    if not readme:
        return {}
    by_lang = _to_localized(readme)
    langs = [lang for lang in by_lang if by_lang[lang]]
    if not langs:
        return {}
    primary = "en" if "en" in langs else langs[0]
    out: dict[str, bytes] = {}
    for lang in langs:
        suffix = "" if lang == primary else f".{lang}"
        out[f"{prefix}README{suffix}.md"] = str(by_lang[lang]).encode("utf-8")
    return out


def _eid(entity: dict) -> str:
    """Port of ``eid`` (entity-io.ts:1920): prefer entityId, else slugify the
    English name (or id, or 'unknown')."""
    if entity.get("entityId"):
        return entity["entityId"]
    return _slugify(_localized_en(entity.get("name")) or entity.get("id") or "unknown")


def _sanitize_connection_config(config: dict, keep_credentials: bool) -> dict:
    """Port of ``sanitizeConnectionConfig`` (entity-io.ts:1798): always strip
    password/token + local file refs; when credentials aren't kept, also strip the
    connection details, leaving only ``engine`` (and any other non-listed field)."""
    always_strip = {"password", "token", "fileId", "fileIds", "fileNames", "fileHandleIds"}
    rest = {k: v for k, v in config.items() if k not in always_strip}
    if keep_credentials:
        return rest
    creds = {"host", "port", "database", "schema", "username", "baseUrl", "authType"}
    return {k: v for k, v in rest.items() if k not in creds}


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
    - unlinked + ``sub_tree`` present → the full project tree nested under
      ``projects/<folder>/`` (built by the caller with build_project_tree).
    - unlinked, no sub_tree → lightweight project.json + README.
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
            pointer = {
                "uid": project.get("uid"),
                "projectId": project.get("projectId"),
                "name": project.get("name"),
                "gitRemoteConfig": git,
            }
            tree[f"projects/{folder}/project.json"] = _json(pointer)
            git_links.add("project", project["uid"], folder, git)
        elif entry.get("sub_tree") is not None:
            for path, content in entry["sub_tree"].items():
                tree[f"projects/{folder}/{path}"] = content
        else:
            tree[f"projects/{folder}/project.json"] = _json(project_meta_out)
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
    Git-linked → a MINIMAL pointer (presetId + optional mapping.presetLabel + git
    pointer; the linked repo's preset.json is the source of truth)."""
    for entry in schemas:
        sp = entry["meta"]
        git = entry.get("git")
        if git:
            folder = _slugify(sp["presetId"])
            mapping = sp.get("mapping") or {}
            pointer: dict = {"presetId": sp["presetId"]}
            if mapping.get("presetLabel"):
                pointer["mapping"] = {"presetLabel": mapping["presetLabel"]}
            pointer["gitRemoteConfig"] = git
            tree[f"schemas/{folder}/_schema.json"] = _json(pointer)
            git_links.add("schema-preset", sp["presetId"], folder, git)
            continue
        tree[f"schemas/{_slugify(sp['presetId'])}.json"] = _json(sp)


def _build_databases_section(
    tree: dict[str, bytes], data_sources: list[dict], keep_credentials: bool
) -> None:
    """Port of the databases/ section (entity-io.ts:1976-1995). Vocabulary
    references are filtered out by the caller. connectionConfig is sanitized here
    (passwords never; credentials opt-in)."""
    for ds in data_sources:
        connection_config = ds.get("connectionConfig")
        rest = {k: v for k, v in ds.items() if k != "connectionConfig"}
        safe = {
            **rest,
            "connectionConfig": (
                _sanitize_connection_config(connection_config, keep_credentials)
                if connection_config
                else None
            ),
        }
        tree[f"databases/{_slugify(ds.get('name') or ds['id'])}.json"] = _json(safe)


def _build_sql_scripts_section(
    tree: dict[str, bytes], collections: list[dict], git_links: _GitLinks
) -> None:
    """Port of the sql-scripts/ section (entity-io.ts:1999-2018). Each entry:
    ``{"meta": <collection>, "git": cfg|None, "folder": str,
       "sub_tree": <dict|None>}`` — the full-content sub-tree (built by the caller
    with ``buildSqlCollectionFolder``'s server equivalent) is present only when the
    per-entity include-data flag is on and the entity is unlinked."""
    for entry in collections:
        collection = entry["meta"]
        git = entry.get("git")
        folder = entry["folder"]
        if git:
            tree[f"sql-scripts/{folder}/_collection.json"] = _json(
                {"id": collection["id"], "name": collection.get("name"), "gitRemoteConfig": git}
            )
            git_links.add("sql-collection", collection["id"], folder, git)
            continue
        if entry.get("sub_tree") is None:
            tree[f"sql-scripts/{folder}/_collection.json"] = _json(collection)
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
            tree[f"etl/{folder}/_pipeline.json"] = _json(
                {"id": pipeline["id"], "name": pipeline.get("name"), "gitRemoteConfig": git}
            )
            git_links.add("etl-pipeline", pipeline["id"], folder, git)
            continue
        if entry.get("sub_tree") is None:
            tree[f"etl/{folder}/_pipeline.json"] = _json(pipeline)
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
            # source of truth; the clone re-applies metadata and checks.
            tree[f"data-quality/{folder}/_ruleset.json"] = _json(
                {
                    "ruleSet": {"id": rs["id"], "name": rs.get("name"), "gitRemoteConfig": git},
                    "checks": [],
                }
            )
            git_links.add("dq-rule-set", rs["id"], folder, git)
            continue
        tree[f"data-quality/{folder}.json"] = _json({"ruleSet": rs, "checks": checks})


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
    - unlinked, no sub_tree → clean project.json only.
    - unlinked + sub_tree → the full folder (built by the caller with
      build_mapping_project_tree, WITHOUT its standalone .gitignore) nested here.
    ``id_ranges`` are the already-portable workspace ranges."""
    for entry in mapping_projects:
        clean_meta = entry["meta"]
        git = entry.get("git")
        folder = entry["folder"]
        if git:
            pointer = {
                "id": entry["id"],
                "entityId": entry.get("entityId"),
                "name": entry.get("name"),
                "gitRemoteConfig": git,
            }
            tree[f"mapping-projects/{folder}/project.json"] = _json(pointer)
            git_links.add("mapping-project", entry["id"], folder, git)
            continue
        if entry.get("sub_tree") is None:
            tree[f"mapping-projects/{folder}/project.json"] = _json(clean_meta)
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
            tree[f"catalogs/{folder}/_catalog.json"] = _json(
                {"id": cat["id"], "name": cat.get("name"), "gitRemoteConfig": git}
            )
            git_links.add("data-catalog", cat["id"], folder, git)
            continue
        tree[f"catalogs/{_eid(cat)}.json"] = _json(cat)

    for sm in service_mappings:
        tree[f"service-mappings/{_slugify(sm.get('name') or sm['id'])}.json"] = _json(sm)


def _build_plugins_section(tree: dict[str, bytes], plugins: list[dict]) -> None:
    """Port of the plugins/ section (entity-io.ts:2132-2143). Built-in plugins are
    filtered out by the caller (they're reconstitutable from the registry on
    import). Each entry is a userPlugin dict with a ``files`` dict."""
    for plugin in plugins:
        folder = plugin.get("entityId") or _slugify(plugin["id"])
        tree[f"plugins/{folder}/_plugin.json"] = _json(
            {
                "id": plugin["id"],
                "entityId": plugin.get("entityId"),
                "workspaceId": plugin.get("workspaceId"),
                "createdBy": plugin.get("createdBy"),
                "createdByDetails": plugin.get("createdByDetails"),
                "createdAt": plugin.get("createdAt"),
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
    schemas: list[dict] | None,
    data_sources: list[dict] | None,
    keep_credentials: bool,
    sql_collections: list[dict] | None,
    etl_pipelines: list[dict] | None,
    dq_rule_sets: list[dict] | None,
    mapping_projects: list[dict] | None,
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

    ws_meta = {k: v for k, v in workspace.items() if k != "readme"}
    ws_out = _strip_instance_fields(ws_meta)
    if workspace.get("organizationId"):
        ws_out["organizationId"] = workspace["organizationId"]
    ws_out["appVersion"] = APP_VERSION
    tree["workspace.json"] = _json(ws_out)

    if workspace.get("organizationId") and organization:
        # org_snapshot drops updatedAt and normalizes createdAt to ms+Z — the same
        # portable shape as the inline org snapshots, so this root org doesn't churn.
        tree["organization.json"] = _json(org_snapshot(organization))

    tree.update(_readme_files("", workspace.get("readme")))

    if projects is not None:
        _build_projects_section(tree, projects, git_links)
    if wiki_pages is not None:
        _build_wiki_section(
            tree, wiki_pages, wiki_attachments or [], wiki_attachment_blobs or {}
        )
    if schemas is not None:
        _build_schemas_section(tree, schemas, git_links)
    if data_sources is not None:
        _build_databases_section(tree, data_sources, keep_credentials)
    if sql_collections is not None:
        _build_sql_scripts_section(tree, sql_collections, git_links)
    if etl_pipelines is not None:
        _build_etl_section(tree, etl_pipelines, git_links)
    if dq_rule_sets is not None:
        _build_data_quality_section(tree, dq_rule_sets, git_links)
    if mapping_projects is not None:
        _build_mapping_projects_section(
            tree, mapping_projects, id_ranges or [], git_links
        )
    if catalogs is not None:
        _build_catalogs_section(tree, catalogs, service_mappings or [], git_links)
    if plugins is not None:
        _build_plugins_section(tree, plugins)

    if git_links.links:
        tree["git-links.json"] = _json(
            {"appVersion": APP_VERSION, "links": git_links.links}
        )

    return tree
