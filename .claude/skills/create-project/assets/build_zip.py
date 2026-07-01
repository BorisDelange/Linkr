#!/usr/bin/env python3
"""Build an importable Linkr project ZIP from a single spec.json.

The spec is authored by hand (or by Claude); this script owns every mechanical
detail of the ZIP format so the spec stays readable:
  - assigns col-N ids from CSV headers and infers column types
  - writes datasets/<slug>/{_columns.json,_data.json,<name>.csv}
  - remaps widget "column" refs (given as CSV header names) to col-N ids
  - assigns dashboard/tab/widget ids and grid layout
  - stamps appVersion, timestamps, .gitignore

Run:  python3 build_zip.py spec.json out.zip

Spec shape (see SKILL.md for the full reference):
{
  "appVersion": "2.0.20",
  "project": {
    "projectId": "icu-activity",
    "name": {"en": "...", "fr": "..."},
    "description": {"en": "...", "fr": "..."},
    "readme": "markdown string (optional)",
    "badges": [{"label": "ICU", "color": "red"}]        # optional
  },
  "datasets": [
    {
      "slug": "icu-stays",           # folder + file name
      "name": "ICU stays",           # display name
      "csv": "icu-stays.csv",        # path to CSV, relative to spec file
      "types": {"age": "number"}     # optional per-column override; else inferred
    }
  ],
  "dashboards": [
    {
      "name": "ICU Activity",
      "tabs": [
        {
          "name": "Demographics",
          "widgets": [ ... ]         # see WIDGET section below
        }
      ]
    }
  ]
}

WIDGETS — each widget references a dataset by slug and columns by CSV HEADER NAME
(this script remaps names -> col-N). Two kinds:

  KPI (linkr-analysis-key-indicator):
  {
    "kind": "kpi",
    "dataset": "icu-stays",
    "name": "Unique patients",
    "column": "person_id",          # header name -> col-N
    "aggregate": "count",           # count | mean | median | sum | proportion | min | max
    "uniquePer": "person_id",       # optional, header name
    "icon": "Users", "color": "blue", "decimals": 0,
    "targetValue": "1",             # required when aggregate = proportion
    "chartType": "none",            # none | histogram | pie
    "config": { ... }               # optional extra raw config keys, merged last
  }

  PLOT (linkr-analysis-plot-builder):
  {
    "kind": "plot",
    "dataset": "icu-stays",
    "name": "Age distribution",
    "plotType": "histogram",        # histogram | bar | line | scatter | box
    "xColumn": "age",               # header name -> col-N
    "yColumn": "los",               # optional, header name -> col-N
    "groupColumn": "sex",           # optional, header name -> col-N
    "config": { ... }               # optional extra raw config keys, merged last
  }

  RAW (escape hatch): {"kind": "raw", "dataset": "...", "name": "...",
                       "source": { full DashboardWidgetSource object }}
  In raw source config, reference columns by col-N yourself.

Layout: widgets flow left-to-right on a 48-column grid, wrapping rows.
Default widget size: KPI = 12x8, plot = 24x16. Override with "w"/"h" on the widget.
"""
import csv
import json
import os
import sys
import uuid
import zipfile

TS = "2026-01-01T00:00:00.000Z"
GRID_COLS = 48


def strip_ext(name):
    """Mirror parseProjectZip: folderName = dsPath.replace(/\\.[^.]+$/, '')."""
    dot = name.rfind(".")
    return name[:dot] if dot > 0 and "/" not in name[dot:] else name


def slugify(name):
    out = []
    prev_dash = False
    for ch in name.lower():
        if ch.isalnum():
            out.append(ch)
            prev_dash = False
        elif not prev_dash:
            out.append("-")
            prev_dash = True
    return "".join(out).strip("-") or "item"


def infer_type(values):
    seen = False
    for v in values:
        if v is None or v == "":
            continue
        seen = True
        try:
            float(v)
        except ValueError:
            return "string"
    return "number" if seen else "string"


def coerce(value, col_type):
    if value is None or value == "":
        return None
    if col_type == "number":
        try:
            f = float(value)
            return int(f) if f.is_integer() else f
        except ValueError:
            return value
    return value


def load_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        rows = list(reader)
    if not rows:
        raise SystemExit(f"CSV {path} is empty")
    header = rows[0]
    body = rows[1:]
    return header, body


def build_dataset(ds, spec_dir):
    csv_path = os.path.join(spec_dir, ds["csv"])
    header, body = load_csv(csv_path)

    types_override = ds.get("types", {})
    columns = []
    name_to_id = {}
    for i, col_name in enumerate(header):
        col_id = f"col-{i}"
        col_values = [row[i] if i < len(row) else "" for row in body]
        col_type = types_override.get(col_name) or infer_type(col_values)
        columns.append({"id": col_id, "name": col_name, "type": col_type, "order": i})
        name_to_id[col_name] = col_id

    data_rows = []
    for row in body:
        obj = {}
        for i, col in enumerate(columns):
            raw = row[i] if i < len(row) else ""
            obj[col["id"]] = coerce(raw, col["type"])
        data_rows.append(obj)

    file_id = str(uuid.uuid4())
    slug = ds.get("slug") or slugify(ds["name"])
    dataset_file = {
        "id": file_id,
        "projectUid": "PLACEHOLDER",  # set by caller
        "name": ds["name"],
        "type": "file",
        "parentId": None,
        "columns": columns,
        "rowCount": len(data_rows),
        "createdAt": TS,
        "updatedAt": TS,
    }
    return {
        "file": dataset_file,
        "slug": slug,
        "columns": columns,
        "rows": data_rows,
        "name_to_id": name_to_id,
        "csv_header": header,
        "csv_body": body,
    }


def resolve_col(dataset, name):
    if name is None:
        return None
    if name in dataset["name_to_id"]:
        return dataset["name_to_id"][name]
    # Allow passing a col-N id directly.
    if name.startswith("col-"):
        return name
    raise SystemExit(f"Column '{name}' not found in dataset '{dataset['slug']}'")


def build_kpi_source(w, dataset):
    cfg = {
        "column": resolve_col(dataset, w["column"]),
        "aggregate": w.get("aggregate", "count"),
        "title": w.get("name", ""),
        "centerTitle": True,
        "icon": w.get("icon", "Activity"),
        "color": w.get("color", "blue"),
        "decimals": w.get("decimals", 0),
        "centerContent": True,
        "chartType": w.get("chartType", "none"),
        "subtitleStats": w.get("subtitleStats", ["n"]),
    }
    if w.get("uniquePer"):
        cfg["uniquePer"] = resolve_col(dataset, w["uniquePer"])
        cfg["uniqueAggregation"] = w.get("uniqueAggregation", "first")
    if w.get("unit"):
        cfg["unit"] = w["unit"]
    if w.get("aggregate") == "proportion":
        cfg["targetValue"] = str(w.get("targetValue", "1"))
    cfg.update(w.get("config", {}))
    return {"type": "plugin", "pluginId": "linkr-analysis-key-indicator", "config": cfg}


def build_plot_source(w, dataset):
    cfg = {
        "plotType": w.get("plotType", "bar"),
        "xColumn": resolve_col(dataset, w.get("xColumn")),
        "title": w.get("name", ""),
        "centerTitle": True,
        "cardColor": w.get("cardColor", "none"),
        "showGrid": w.get("showGrid", True),
        "showLegend": w.get("showLegend", False),
        "colorPalette": w.get("colorPalette", "default"),
        "opacity": w.get("opacity", 80),
        "excludeNA": w.get("excludeNA", True),
    }
    if w.get("yColumn"):
        cfg["yColumn"] = resolve_col(dataset, w["yColumn"])
    if w.get("groupColumn"):
        cfg["groupColumn"] = resolve_col(dataset, w["groupColumn"])
        cfg["showLegend"] = w.get("showLegend", True)
    for key in ("binMode", "binWidth", "binMode", "barMode", "xLabel", "yLabel",
                "uniquePer", "uniqueAggregation", "legendPosition"):
        if key in w:
            cfg[key] = resolve_col(dataset, w[key]) if key == "uniquePer" else w[key]
    cfg.update(w.get("config", {}))
    return {"type": "plugin", "pluginId": "linkr-analysis-plot-builder", "config": cfg}


def layout_next(cursor, w, h):
    """Flow widgets left-to-right on GRID_COLS, wrapping to a new row."""
    if cursor["x"] + w > GRID_COLS:
        cursor["x"] = 0
        cursor["y"] = cursor["row_y"]
    x, y = cursor["x"], cursor["y"]
    cursor["x"] += w
    cursor["row_y"] = max(cursor["row_y"], y + h)
    return {"x": x, "y": y, "w": w, "h": h}


# type -> default inputType, mirroring the dashboard filter sidebar's detectDefaults.
FILTER_DEFAULTS = {
    "number": ("numeric", "range"),
    "date": ("date", "range"),
    "string": ("categorical", "multi-select"),
    "boolean": ("categorical", "multi-select"),
}


def build_filters(dash, datasets_by_slug):
    """A filter references a dataset by slug and a column by header name.
    type/inputType default from the column's type; override either in the spec."""
    filters = []
    for f in dash.get("filters", []):
        ds = datasets_by_slug[f["dataset"]]
        col = next(c for c in ds["columns"] if c["id"] == resolve_col(ds, f["column"]))
        ftype, input_type = FILTER_DEFAULTS.get(col["type"], ("categorical", "multi-select"))
        entry = {
            "id": str(uuid.uuid4()),
            "datasetFileId": ds["file"]["id"],
            "columnId": col["id"],
            "columnName": col["name"],
            "type": f.get("type", ftype),
            "inputType": f.get("inputType", input_type),
        }
        if f.get("label"):
            entry["label"] = f["label"]
        filters.append(entry)
    return filters


def build_dashboard(dash, datasets_by_slug):
    dash_id = str(uuid.uuid4())
    dashboard = {
        "id": dash_id,
        "projectUid": "PLACEHOLDER",
        "name": dash["name"],
        "filterConfig": build_filters(dash, datasets_by_slug),
        "showWidgetTitles": dash.get("showWidgetTitles", False),
        "gridV": 2,
        "createdAt": TS,
        "updatedAt": TS,
    }
    tabs = []
    widgets = []
    for order, tab in enumerate(dash["tabs"]):
        tab_id = str(uuid.uuid4())
        tabs.append({
            "id": tab_id,
            "dashboardId": dash_id,
            "name": tab["name"],
            "displayOrder": order,
        })
        cursor = {"x": 0, "y": 0, "row_y": 0}
        for w in tab.get("widgets", []):
            ds = datasets_by_slug.get(w["dataset"]) if w.get("dataset") else None
            kind = w.get("kind", "kpi")
            if kind == "kpi":
                default_w, default_h = 12, 8
                source = build_kpi_source(w, ds)
            elif kind == "plot":
                default_w, default_h = 24, 16
                source = build_plot_source(w, ds)
            elif kind == "raw":
                default_w, default_h = 24, 16
                source = w["source"]
            else:
                raise SystemExit(f"Unknown widget kind: {kind}")
            wl = layout_next(cursor, w.get("w", default_w), w.get("h", default_h))
            widgets.append({
                "id": str(uuid.uuid4()),
                "tabId": tab_id,
                "name": w.get("name", ""),
                "datasetFileId": ds["file"]["id"] if ds else None,
                "layout": wl,
                "source": source,
            })
    return {"dashboard": dashboard, "tabs": tabs, "widgets": widgets}


def json_bytes(obj):
    return json.dumps(obj, indent=2, ensure_ascii=False).encode("utf-8")


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: build_zip.py spec.json out.zip")
    spec_path, out_path = sys.argv[1], sys.argv[2]
    spec_dir = os.path.dirname(os.path.abspath(spec_path))
    with open(spec_path, encoding="utf-8") as f:
        spec = json.load(f)

    app_version = spec.get("appVersion", "2.0.20")
    project_uid = str(uuid.uuid4())

    p = spec["project"]
    badges = [
        {"id": f"b{i}", "label": b["label"], "color": b.get("color", "blue")}
        for i, b in enumerate(p.get("badges", []))
    ]
    project = {
        "uid": project_uid,
        "projectId": p.get("projectId") or slugify(next(iter(p["name"].values()))),
        "name": p["name"],
        "description": p.get("description", {}),
        "shortDescription": p.get("shortDescription", {}),
        "config": p.get("config", {}),
        "ownerId": p.get("ownerId", 1),
        "status": p.get("status", "active"),
        "badges": badges,
        "createdAt": TS,
        "updatedAt": TS,
    }
    if "workspaceId" in p:
        project["workspaceId"] = p["workspaceId"]

    # Build datasets.
    datasets = []
    datasets_by_slug = {}
    for ds_spec in spec.get("datasets", []):
        ds = build_dataset(ds_spec, spec_dir)
        ds["file"]["projectUid"] = project_uid
        datasets.append(ds)
        datasets_by_slug[ds["slug"]] = ds

    # Build dashboards.
    dashboards = []
    for dash_spec in spec.get("dashboards", []):
        bundle = build_dashboard(dash_spec, datasets_by_slug)
        bundle["dashboard"]["projectUid"] = project_uid
        for w in bundle["widgets"]:
            pass  # projectUid not on widgets
        dashboards.append(bundle)

    # Assemble ZIP.
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("project.json", json_bytes({**project, "appVersion": app_version}))
        if p.get("readme"):
            z.writestr("README.md", p["readme"])
        z.writestr("tasks.json", json_bytes({"todos": p.get("todos", []), "notes": p.get("notes", "")}))

        if datasets:
            tree = [ds["file"] for ds in datasets]
            z.writestr("datasets/_tree.json", json_bytes(tree))
            for ds in datasets:
                # The parser rebuilds the folder from the dataset's `name` (minus any
                # trailing extension), NOT from `slug` — mirror buildDatasetPath exactly
                # so _data.json / _columns.json are found on import.
                folder = strip_ext(ds["file"]["name"])
                z.writestr(f"datasets/{folder}/_columns.json", json_bytes(ds["columns"]))
                z.writestr(f"datasets/{folder}/_data.json", json_bytes({"rows": ds["rows"]}))
                # Original CSV kept verbatim so "Import settings" works after re-import.
                csv_name = f"{ds['slug']}.csv"
                out = [",".join(csv_escape(c) for c in ds["csv_header"])]
                for row in ds["csv_body"]:
                    out.append(",".join(csv_escape(c) for c in row))
                z.writestr(f"datasets/{folder}/{csv_name}", "\n".join(out))

        for bundle in dashboards:
            slug = slugify(bundle["dashboard"]["name"])
            z.writestr(f"dashboards/{slug}.json", json_bytes(bundle))

        z.writestr(".gitignore", "datasets/**/*.csv\ndatasets/**/*.parquet\n.cache/\n")

    n_ds = len(datasets)
    n_w = sum(len(b["widgets"]) for b in dashboards)
    print(f"Wrote {out_path}")
    print(f"  project: {project['projectId']}  uid={project_uid}")
    print(f"  datasets: {n_ds}  dashboards: {len(dashboards)}  widgets: {n_w}")


def csv_escape(v):
    s = "" if v is None else str(v)
    if any(c in s for c in [",", '"', "\n"]):
        return '"' + s.replace('"', '""') + '"'
    return s


if __name__ == "__main__":
    main()
