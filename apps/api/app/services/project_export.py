"""Server-side builder for the project export tree — a byte-faithful Python port
of the frontend git-variant builder
(apps/web/src/lib/entity-io.ts ``buildProjectZip``).

Returns the extracted ``{path: bytes}`` tree (NOT a zip container): git versions
the extracted files, and the container isn't byte-reproducible across JSZip and
Python ``zipfile``. A thin caller zips this tree for commit/push or download.

Parity matters: this MUST match the TS builder byte for byte, or a front-only
client and a server client versioning the same repo produce false git diffs. The
shared golden fixture + twin tests
(apps/web/src/lib/entity-io/__fixtures__/export-golden/project/,
apps/web/src/lib/entity-io.project-golden.test.ts, and
apps/api/tests/test_project_export.py) guard this. See
docs/architecture.md ("Fullstack Storage & Compute") for the contract.

This is a PURE module: it takes already-loaded data (camelCase dicts + raw
bytes in the SAME shape/order the frontend's Storage façade yields in server
mode) and returns the file tree — the DB/disk/blob reads live in the caller
(project_export_assemble).
"""

import unicodedata
from typing import Any

# The export-format version stamped into project.json (``appVersion``) — see
# app/export_version.py. NOT config.app_version (the deployment/build version):
# this must equal the frontend's version.ts APP_VERSION so front-only and server
# exports are byte-identical.
from app.core.json_export import export_json as _json
from app.export_version import EXPORT_APP_VERSION as APP_VERSION
from app.services.org_snapshot import org_snapshot

# Fields specific to the exporting instance/deployment, dropped from every
# exported entity's metadata — mirrors INSTANCE_FIELDS in
# apps/web/src/lib/entity-io.ts. ``createdAt`` is NOT here (portable provenance,
# kept like createdBy); only ``updatedAt`` moves on every edit, so it is dropped.
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


def _strip_instance_fields(meta: dict) -> dict:
    """Port of ``stripInstanceFields`` (entity-io.ts:417): copy, drop the
    instance-specific fields (preserving key order), then drop an empty
    ``createdAt`` (a legacy record predating creation-date tracking — a real
    createdAt is kept as portable provenance)."""
    out = {k: v for k, v in meta.items() if k not in _INSTANCE_FIELDS}
    if not out.get("createdAt"):
        out.pop("createdAt", None)
    return out


def _slugify(name: str) -> str:
    """Port of ``slugify`` (entity-io.ts:143): NFD-normalize, strip combining
    marks, lowercase, non-alphanumeric runs → ``-``, trim leading/trailing ``-``,
    fall back to ``export`` when empty."""
    decomposed = unicodedata.normalize("NFD", name)
    without_marks = "".join(c for c in decomposed if not unicodedata.combining(c))
    lowered = without_marks.lower()
    out = []
    prev_dash = False
    for ch in lowered:
        if ch.isascii() and (ch.isalnum()):
            out.append(ch)
            prev_dash = False
        else:
            if not prev_dash:
                out.append("-")
                prev_dash = True
    slug = "".join(out).strip("-")
    return slug or "export"


def _localized_en(value: Any) -> str:
    """Port of ``localized(value, 'en')`` for the export's uses: a bare string is
    returned as-is; a LocalizedString dict prefers ``en`` then the first value."""
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
    """Port of ``toLocalized`` for notes/readme: dict stays, a non-empty string
    becomes ``{'en': value}``, empty/None becomes ``{}``."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        return {"en": value}
    return {}


def _dashboard_key(dashboard: dict) -> str:
    return _slugify(_localized_en(dashboard.get("name")))


def _build_tab_key_map(dash_key: str, tabs: list[dict]) -> dict[str, str]:
    """Port of ``buildTabKeyMap`` (entity-io.ts:341)."""
    key_of: dict[str, str] = {}
    seen: set[str] = set()
    # Parents before children so a sub-tab's parent key is already resolved. Stable
    # sort keeps the original order among same-group tabs (JS Array.sort is stable).
    ordered = sorted(tabs, key=lambda t: 1 if t.get("parentTabId") else 0)
    for tab in ordered:
        base = _slugify(_localized_en(tab.get("name")))
        parent = key_of.get(tab["parentTabId"]) if tab.get("parentTabId") else None
        key = f"{parent if parent is not None else dash_key}/{base}"
        if key in seen:
            key = f"{key}#{tab.get('displayOrder')}"
        seen.add(key)
        key_of[tab["id"]] = key
    return key_of


def _build_widget_key_map(
    tab_key_map: dict[str, str], widgets: list[dict]
) -> dict[str, str]:
    """Port of ``buildWidgetKeyMap`` (entity-io.ts:361)."""
    key_of: dict[str, str] = {}
    seen: set[str] = set()
    for w in widgets:
        tab_key = tab_key_map.get(w["tabId"], "")
        layout = w.get("layout") or {}
        base = (
            f"{tab_key}/{_slugify(_localized_en(w.get('name')))}"
            f"@{layout.get('y')},{layout.get('x')}"
        )
        key = base
        i = 1
        while key in seen:
            key = f"{base}#{i}"
            i += 1
        seen.add(key)
        key_of[w["id"]] = key
    return key_of


def _build_dashboard_json(
    dashboard: dict, tabs: list[dict], widgets: list[dict]
) -> bytes:
    """Port of the per-dashboard transform (entity-io.ts:532-581): strip instance
    fields + UUID ids, replace them with content keys, remap filterConfig scope
    ids to keys."""
    dash_key = _dashboard_key(dashboard)
    tab_key_map = _build_tab_key_map(dash_key, tabs)
    widget_key_map = _build_widget_key_map(tab_key_map, widgets)

    dashboard_out = _strip_instance_fields(dashboard)
    dashboard_out.pop("id", None)
    dashboard_out.pop("projectUid", None)
    filter_config = dashboard_out.get("filterConfig")
    if isinstance(filter_config, list):
        remapped = []
        for f in filter_config:
            out = {k: v for k, v in f.items() if k != "id"}
            scope = f.get("scope")
            if isinstance(scope, dict) and scope.get("type") == "tabs":
                out["scope"] = {
                    "type": "tabs",
                    "tabKeys": [tab_key_map.get(i, i) for i in scope.get("tabIds", [])],
                }
            elif isinstance(scope, dict) and scope.get("type") == "widgets":
                out["scope"] = {
                    "type": "widgets",
                    "widgetKeys": [
                        widget_key_map.get(i, i) for i in scope.get("widgetIds", [])
                    ],
                }
            remapped.append(out)
        dashboard_out["filterConfig"] = remapped

    tabs_out = []
    for tab in tabs:
        out = _strip_instance_fields(tab)
        key = tab_key_map[tab["id"]]
        parent_key = (
            tab_key_map.get(tab["parentTabId"]) if tab.get("parentTabId") else None
        )
        out.pop("id", None)
        out.pop("dashboardId", None)
        out.pop("parentTabId", None)
        out["key"] = key
        out["parentKey"] = parent_key
        tabs_out.append(out)
    # Sort by content key so array order is byte-stable across instances (storage
    # returns PK order, which differs pre/post-reimport) — mirrors the TS builder
    # (entity-io.ts). Python str sort is code-point order == JS compareCodePoints.
    tabs_out.sort(key=lambda t: t["key"])

    widgets_out = []
    for w in widgets:
        out = _strip_instance_fields(w)
        key = widget_key_map[w["id"]]
        tab_key = tab_key_map[w["tabId"]]
        out.pop("id", None)
        out.pop("tabId", None)
        out["key"] = key
        out["tabKey"] = tab_key
        widgets_out.append(out)
    widgets_out.sort(key=lambda w: (w["tabKey"], w["key"]))

    return _json({"dashboard": dashboard_out, "tabs": tabs_out, "widgets": widgets_out})


def _build_project_json(project: dict, organization: dict | None) -> bytes:
    """Port of the project.json transform (entity-io.ts:474-475 + attachEntity-
    Organization:1473).

    Drop readme/todos/notes/uid (own files / regenerated PK) and the instance
    fields, append ``appVersion``, then append the inherited ``organization``
    snapshot at the end when one resolves."""
    dropped = {"readme", "todos", "notes", "uid"}
    meta = {k: v for k, v in project.items() if k not in dropped}
    out = _strip_instance_fields(meta)
    out["appVersion"] = APP_VERSION
    if organization:
        out["organization"] = org_snapshot(organization)
    return _json(out)


def _readme_files(readme: Any) -> dict[str, bytes]:
    """Port of ``writeReadmeFiles`` (entity-io.ts:35) at the project root:
    ``README.md`` for the primary language (en, else the first), ``README.<lang>.md``
    for the rest. Content is written as UTF-8 text verbatim."""
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
        out[f"README{suffix}.md"] = str(by_lang[lang]).encode("utf-8")
    return out


def _ide_path(file: dict, by_id: dict[str, dict]) -> str:
    """Port of ``buildIdePath`` (entity-io.ts:289): reconstruct the path from the
    parent-name chain, prefixing ``scripts/`` when not already under it."""
    parts = [file["name"]]
    current = file
    while current.get("parentId"):
        parent = by_id.get(current["parentId"])
        if not parent:
            break
        parts.insert(0, parent["name"])
        current = parent
    if parts[0] != "scripts":
        parts.insert(0, "scripts")
    return "/".join(parts)


def _dataset_path(file: dict, by_id: dict[str, dict]) -> str:
    """Port of ``buildDatasetPath`` (entity-io.ts:307)."""
    parts = [file["name"]]
    current = file
    while current.get("parentId"):
        parent = by_id.get(current["parentId"])
        if not parent:
            break
        parts.insert(0, parent["name"])
        current = parent
    return "/".join(parts)


def _dataset_to_csv(df: dict, rows: list[dict]) -> bytes:
    """Port of ``datasetToCsv`` (entity-io.ts:441): header uses column NAMES, rows
    are keyed by column ids; quote on ``,``/``"``/``\\n`` and double ``"``; ``\\n``
    line terminator, no trailing newline."""
    columns = df.get("columns") or []
    col_ids = [c["id"] for c in columns] if columns else (
        list(rows[0].keys()) if rows else []
    )
    col_names = [c["name"] for c in columns] if columns else col_ids

    def escape(v: Any) -> str:
        if v is None:
            return ""
        s = str(v)
        if "," in s or '"' in s or "\n" in s:
            return '"' + s.replace('"', '""') + '"'
        return s

    lines = [",".join(col_names)]
    for row in rows:
        lines.append(",".join(escape(row.get(cid)) for cid in col_ids))
    return "\n".join(lines).encode("utf-8")


def build_project_tree(
    project: dict,
    organization: dict | None,
    ide_files: list[dict],
    pipelines: list[dict],
    cohorts: list[dict],
    connections: list[dict],
    dashboards: list[dict[str, Any]],
    dataset_files: list[dict],
    dataset_analyses: dict[str, list[dict]],
    dataset_data: dict[str, list[dict]],
    dataset_raw_files: dict[str, dict],
    attachments: list[dict],
    attachment_blobs: dict[str, bytes],
    include_data_files: bool,
) -> dict[str, bytes]:
    """Build the git-variant project export tree as ``{path: bytes}``.

    Byte-faithful to ``buildProjectZip``. Inputs are the camelCase shapes the
    frontend's Storage yields in server mode (the caller shapes ORM rows to
    match). ``dashboards`` is a list of ``{dashboard, tabs, widgets}`` groups (the
    caller pre-loads each dashboard's tabs + widgets). ``dataset_analyses`` /
    ``dataset_data`` / ``dataset_raw_files`` are keyed by dataset-file id; blobs by
    attachment id.
    """
    tree: dict[str, bytes] = {}

    tree["project.json"] = _build_project_json(project, organization)

    tree.update(_readme_files(project.get("readme")))

    notes = _to_localized(project.get("notes"))
    has_notes = any(bool(v) for v in notes.values())
    todos = project.get("todos") or []
    if todos or has_notes:
        tree["tasks.json"] = _json({"todos": todos, "notes": notes})

    # IDE files: drop the synthetic "scripts" root folder (a UI convenience, not
    # repo content) and reparent its direct children to null, so scripts/_tree.json
    # matches a git-authored tree.
    synthetic_root = next(
        (
            f
            for f in ide_files
            if f.get("parentId") is None
            and f.get("type") == "folder"
            and f.get("name") == "scripts"
        ),
        None,
    )
    ide = []
    for f in ide_files:
        if synthetic_root is not None and f is synthetic_root:
            continue
        if synthetic_root is not None and f.get("parentId") == synthetic_root["id"]:
            ide.append({**f, "parentId": None})
        else:
            ide.append(f)
    if ide:
        by_id = {f["id"]: f for f in ide}
        tree["scripts/_tree.json"] = _json(
            [
                {k: v for k, v in f.items() if k not in ("content", "projectUid")}
                for f in ide
            ]
        )
        for f in ide:
            if f.get("type") == "file" and f.get("content") is not None:
                tree[_ide_path(f, by_id)] = str(f["content"]).encode("utf-8")

    if pipelines:
        tree["pipeline/pipeline.json"] = _json(
            [_strip_instance_fields(p) for p in pipelines]
        )

    for c in cohorts:
        tree[f"cohorts/{_slugify(c.get('name') or c['id'])}.json"] = _json(
            _strip_instance_fields(c)
        )

    for c in connections:
        tree[f"databases/{_slugify(c.get('name') or c['id'])}.json"] = _json(
            _strip_instance_fields(c)
        )

    for group in dashboards:
        d = group["dashboard"]
        tabs = group.get("tabs", [])
        widgets = group.get("widgets", [])
        dash_key = _dashboard_key(d)
        name = _slugify(_localized_en(d.get("name")) or dash_key or d["id"])
        tree[f"dashboards/{name}.json"] = _build_dashboard_json(d, tabs, widgets)

    if dataset_files:
        by_id = {f["id"]: f for f in dataset_files}
        tree["datasets/_tree.json"] = _json(
            [_strip_instance_fields(f) for f in dataset_files]
        )
        for df in dataset_files:
            if df.get("type") != "file":
                continue
            ds_path = _dataset_path(df, by_id)
            folder_name = ds_path.rsplit(".", 1)[0] if "." in ds_path.rsplit("/", 1)[-1] else ds_path

            columns = df.get("columns")
            if columns:
                tree[f"datasets/{folder_name}/_columns.json"] = _json(columns)

            for a in dataset_analyses.get(df["id"], []):
                tree[
                    f"datasets/{folder_name}/{_slugify(a.get('name') or a['id'])}.json"
                ] = _json(_strip_instance_fields(a))

            if include_data_files:
                rows = dataset_data.get(df["id"])
                raw = dataset_raw_files.get(df["id"])
                if raw and raw.get("blob") is not None:
                    tree[f"datasets/{folder_name}/{raw['fileName']}"] = raw["blob"]
                    if rows:
                        tree[f"datasets/{folder_name}/_data.json"] = _json(
                            {"rows": rows}
                        )
                elif rows:
                    leaf = ds_path.rsplit("/", 1)[-1] or df["name"]
                    base_name = leaf.rsplit(".", 1)[0] if "." in leaf else leaf
                    tree[f"datasets/{folder_name}/{base_name}.csv"] = _dataset_to_csv(
                        df, rows
                    )

    if attachments:
        tree["attachments/_meta.json"] = _json(
            [{k: v for k, v in a.items() if k != "data"} for a in attachments]
        )
        for att in attachments:
            blob = attachment_blobs.get(att["id"])
            if blob is not None:
                tree[f"attachments/{att['id']}-{att['fileName']}"] = blob

    gitignore_lines = [".cache/"]
    if not include_data_files:
        gitignore_lines = [
            "datasets/**/*.csv",
            "datasets/**/*.parquet",
            "datasets/**/*.xlsx",
            "datasets/**/*.xls",
            *gitignore_lines,
        ]
    tree[".gitignore"] = ("\n".join(gitignore_lines) + "\n").encode("utf-8")

    return tree
