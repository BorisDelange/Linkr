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

import re
import unicodedata
from typing import Any

# The export-format version stamped into project.json (``appVersion``) — see
# app/export_version.py. NOT config.app_version (the deployment/build version):
# this must equal the frontend's version.ts APP_VERSION so front-only and server
# exports are byte-identical.
from app.core.json_export import export_json as _json
from app.export_version import EXPORT_APP_VERSION as APP_VERSION
from app.services.entity_docs import license_file, license_meta
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
    # Machine-local server-path bindings — never travel with an export.
    "idePath",
    "scriptsPath",
    "datasetsPath",
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


def _canonical_parse_options(opts: dict) -> dict:
    """parseOptions with keys (and nested per-column maps) sorted — mirrors
    entity-io.ts:canonicalParseOptions and dataset_fs._canonical_parse_options, so
    the datasets/_tree.json ordering is independent of the option write history and
    identical front/back."""
    out: dict = {}
    for k in sorted(opts):
        v = opts[k]
        out[k] = {ck: v[ck] for ck in sorted(v)} if isinstance(v, dict) else v
    return out


def _dataset_export_meta(df: dict) -> dict:
    """Dataset file export metadata: instance fields stripped + parseOptions keys
    canonicalised (parity-stable ordering)."""
    out = _strip_instance_fields(df)
    opts = out.get("parseOptions")
    if isinstance(opts, dict):
        out = {**out, "parseOptions": _canonical_parse_options(opts)}
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
    # Falls back to the id like the TS twin (entity-io dashboardKey) and
    # project-pull's natural key, so an unnamed dashboard stays stable.
    return _slugify(_localized_en(dashboard.get("name")) or dashboard.get("id") or "")


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


def _prune_marked_paths(project: dict, live_mark_keys: set[str]) -> dict:
    """Drop config.versionedDataFiles / excludedFiles entries whose file no longer
    exists in the export (marking key not in ``live_mark_keys``). A file marked "to
    version" (or "do not version") and later deleted would otherwise linger in
    project.json forever with no UI to clear it. Order is preserved. Byte-parity
    with buildProjectZip's pruning. Returns a shallow copy when it changes anything."""
    config = project.get("config")
    if not isinstance(config, dict):
        return project
    new_config = dict(config)
    changed = False
    for key in ("versionedDataFiles", "excludedFiles"):
        raw = config.get(key)
        if not isinstance(raw, list):
            continue
        pruned = [p for p in raw if isinstance(p, str) and p in live_mark_keys]
        if pruned != raw:
            new_config[key] = pruned
            changed = True
    if not changed:
        return project
    return {**project, "config": new_config}


def _build_project_json(project: dict, organization: dict | None) -> bytes:
    """Port of the project.json transform (entity-io.ts:474-475 + attachEntity-
    Organization:1473).

    Drop readme/todos/notes/uid (own files / regenerated PK) and the instance
    fields, reduce ``license`` to its identity (the text travels as LICENSE.md),
    append ``appVersion``, then append the inherited ``organization`` snapshot at
    the end when one resolves."""
    dropped = {"readme", "todos", "notes", "uid", "license"}
    meta = {k: v for k, v in project.items() if k not in dropped}
    out = _strip_instance_fields(meta)
    licence = license_meta(project.get("license"))
    if licence is not None:
        out["license"] = licence
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


_DATA_EXTENSIONS = (".csv", ".parquet", ".pq", ".xlsx", ".xls")


def _is_data_ext(path: str) -> bool:
    return path.lower().endswith(_DATA_EXTENSIONS)


def _gitignore_escape(p: str) -> str:
    """Port of ``gitignoreEscapePath`` (entity-io.ts): escape gitignore
    metacharacters (`\\ [ ] * ? # !`) and trailing spaces so a `!path` exception
    is read as a literal, not a pattern. MUST byte-match the TS for mixed-mode
    remote parity."""
    out = re.sub(r"([\\\[\]*?#!])", r"\\\1", p)
    return re.sub(r" +$", lambda m: m.group(0).replace(" ", "\\ "), out)


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
    versioned_data_files: set[str],
    excluded_files: set[str] | None = None,
    env_specs: dict[str, bytes] | None = None,
    concept_lists: list[dict] | None = None,
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
    # Tree paths of data files written into the export — each becomes a `!path`
    # exception in .gitignore. Collected across scripts/ (reference data) + datasets/.
    included_data_paths: list[str] = []

    # Marking keys of the files that actually exist in this export, so a config that
    # still lists a since-deleted marked/excluded file (versionedDataFiles /
    # excludedFiles) is pruned before it's written to project.json — a deleted file
    # then drops out of the versioned config instead of lingering forever.
    _ide_by_id = {f["id"]: f for f in ide_files}
    live_mark_keys = {
        _ide_path(f, _ide_by_id) for f in ide_files if f.get("type") == "file"
    } | {
        f"datasets/{_dataset_path(f, {df['id']: df for df in dataset_files})}"
        for f in dataset_files
        if f.get("type") == "file"
    }
    project = _prune_marked_paths(project, live_mark_keys)

    tree["project.json"] = _build_project_json(project, organization)

    tree.update(_readme_files(project.get("readme")))
    tree.update(license_file("", project.get("license")))

    notes = _to_localized(project.get("notes"))
    has_notes = any(bool(v) for v in notes.values())
    todos = project.get("todos") or []
    if todos or has_notes:
        tree["tasks.json"] = _json({"todos": todos, "notes": notes})

    # The disk scan no longer emits a synthetic "scripts" root (files sit at the
    # root of the IDE working dir). This stays defensive for any legacy/imported
    # tree that still carries one: drop it and reparent its children to null so
    # scripts/_tree.json always matches a git-authored, root-less tree.
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
    excluded = excluded_files or set()
    if ide:
        by_id = {f["id"]: f for f in ide}

        def _is_excluded_code(f: dict) -> bool:
            # Code files are versioned by default; an excludedFiles entry omits the
            # file from the tree entirely (data files opt IN via versioned_data_files).
            if f.get("type") != "file":
                return False
            tp = _ide_path(f, by_id)
            return not _is_data_ext(tp) and tp in excluded

        tree_files = [f for f in ide if not _is_excluded_code(f)]
        # Only emit the tree when something survives the exclusions — otherwise every
        # script is excluded and we'd version a useless `scripts/_tree.json: []`.
        if tree_files:
            # Keyed by the path relative to scripts/ (port of entity-tree.ts): no
            # id/parentId in the versioned tree, so a re-import can't churn them.
            # Sorted by path so the bytes don't depend on the scan/row order.
            dropped = {"id", "parentId", "name", "content", "projectUid"}
            tree["scripts/_tree.json"] = _json(
                sorted(
                    (
                        {
                            "path": _ide_path(f, by_id).removeprefix("scripts/"),
                            **{k: v for k, v in f.items() if k not in dropped},
                        }
                        for f in tree_files
                    ),
                    # UTF-16 code units, matching JS string comparison — see
                    # workspace_export_assemble._utf16_key.
                    key=lambda n: n["path"].encode("utf-16-be"),
                )
            )
        for f in ide:
            if f.get("type") == "file" and f.get("content") is not None:
                if _is_excluded_code(f):
                    continue
                tree_path = _ide_path(f, by_id)
                tree[tree_path] = str(f["content"]).encode("utf-8")
                # A data file under scripts/ (e.g. a reference CSV) is gitignored like
                # any data file; re-include it when marked (key = its scripts/ path).
                if _is_data_ext(tree_path) and tree_path in versioned_data_files:
                    included_data_paths.append(tree_path)

    # Managed-environment specs (manifest + lockfile) under environments/<lang>/.
    # Versioned in the project git so a clone reproduces the packages; the
    # materialised venv/library (.cache/) is gitignored. Server-mode only — front
    # -only mode passes none, so parity holds (both emit nothing).
    for path, content in sorted((env_specs or {}).items()):
        tree[path] = content

    if pipelines:
        tree["pipeline/pipeline.json"] = _json(
            [_strip_instance_fields(p) for p in pipelines]
        )

    for c in cohorts:
        tree[f"cohorts/{_slugify(c.get('name') or c['id'])}.json"] = _json(
            _strip_instance_fields(c)
        )

    # User-authored concept lists. Names are LocalizedString, so the slug comes
    # from the English value — the same rule the frontend export uses, or git
    # would see a rename on every round-trip.
    for cl in concept_lists or []:
        label = _localized_en(cl.get("name")) or cl["id"]
        tree[f"concept-lists/{_slugify(label)}.json"] = _json(
            _strip_instance_fields(cl)
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
            [_dataset_export_meta(f) for f in dataset_files]
        )
        for df in dataset_files:
            if df.get("type") != "file":
                continue
            ds_path = _dataset_path(df, by_id)
            folder_name = ds_path.rsplit(".", 1)[0] if "." in ds_path.rsplit("/", 1)[-1] else ds_path

            # columns (with label/description/valueLabels) travel inline in
            # _tree.json — the redundant per-dataset _columns.json is no longer
            # written (it was never read back on import; see dataset-metadata-plan).

            for a in dataset_analyses.get(df["id"], []):
                tree[
                    f"datasets/{folder_name}/{_slugify(a.get('name') or a['id'])}.json"
                ] = _json(_strip_instance_fields(a))

            # A data file leaves the machine only when the user marked it for
            # versioning. Marking key is the logical `datasets/<ds_path>`; the tree
            # path (datasets/<folder>/<file>) is recorded for the .gitignore exception.
            if f"datasets/{ds_path}" in versioned_data_files:
                rows = dataset_data.get(df["id"])
                raw = dataset_raw_files.get(df["id"])
                if raw and raw.get("blob") is not None:
                    tree[f"datasets/{folder_name}/{raw['fileName']}"] = raw["blob"]
                    included_data_paths.append(f"datasets/{folder_name}/{raw['fileName']}")
                    if rows:
                        tree[f"datasets/{folder_name}/_data.json"] = _json(
                            {"rows": rows}
                        )
                        included_data_paths.append(f"datasets/{folder_name}/_data.json")
                elif rows:
                    leaf = ds_path.rsplit("/", 1)[-1] or df["name"]
                    base_name = leaf.rsplit(".", 1)[0] if "." in leaf else leaf
                    tree[f"datasets/{folder_name}/{base_name}.csv"] = _dataset_to_csv(
                        df, rows
                    )
                    included_data_paths.append(f"datasets/{folder_name}/{base_name}.csv")

    if attachments:
        # Sorted by id, like writeAttachmentFiles: the caller's order is whatever
        # the query returned, and with two attachments the client and the server
        # emitted _meta.json differently — a false git diff on every export.
        # Sorted by id, like writeAttachmentFiles: the caller's order is whatever
        # the query returned, and with two attachments the client and the server
        # emitted _meta.json differently — a false git diff on every export.
        attachments = sorted(attachments, key=lambda a: a["id"])
        # Exactly the five portable keys, in this order — the owner fields are
        # re-stamped from context on import, so they never travel (mirrors
        # writeAttachmentFiles in entity-io.ts).
        tree["attachments/_meta.json"] = _json(
            [
                {
                    "id": a["id"],
                    "fileName": a["fileName"],
                    "mimeType": a["mimeType"],
                    "fileSize": a["fileSize"],
                    "createdAt": a.get("createdAt"),
                }
                for a in attachments
            ]
        )
        for att in attachments:
            blob = attachment_blobs.get(att["id"])
            if blob is not None:
                tree[f"attachments/{att['id']}-{att['fileName']}"] = blob

    # Data files ignored by default EVERYWHERE (datasets/ AND scripts/); each marked
    # file is re-included via a `!path` exception AFTER the ignore rules (git honours
    # the last match). Byte-faithful to buildProjectZip's .gitignore block.
    gitignore_lines = [
        "**/*.csv",
        "**/*.parquet",
        "**/*.pq",
        "**/*.xlsx",
        "**/*.xls",
        ".cache/",
    ]
    gitignore_lines.extend(f"!{_gitignore_escape(p)}" for p in included_data_paths)
    tree[".gitignore"] = ("\n".join(gitignore_lines) + "\n").encode("utf-8")

    return tree
