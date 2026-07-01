---
name: create-project
description: Generate a ready-to-import Linkr project ZIP — a project with synthetic dataset(s) and a wired dashboard (KPIs + charts), assembled into the importable project ZIP format. Use when the user wants a demo project, sample data, or a dashboard built from scratch to drag into the app.
argument-hint: [theme] [n-rows]
---

# Create an importable Linkr project

You build a **project ZIP** the user can import via "Import a project" in the app.
You never touch app source code — the output is a data artifact.

The mechanical ZIP assembly (col-N ids, `_data.json`, dashboard/tab/widget ids,
48-col grid layout, `appVersion`, `.gitignore`) is owned by `assets/build_zip.py`.
Your job is to author **one CSV per dataset** and **one `spec.json`**, then run the script.

## Step 1 — Gather requirements

Ask the user (unless already given):
1. **Theme / clinical domain** (e.g. ICU activity, sepsis cohort).
2. **What indicators/charts** they want on the dashboard.
3. **Row count** for the synthetic data (default ~200; more = more realistic distributions).
4. **Languages** — project name/description are localized `{en, fr}`. Fill both.

## Step 2 — Author the CSV(s)

Write one CSV per dataset into the working directory. First row = headers (real
column names like `person_id`, `age`, `sex`). Make the data **clinically coherent**:
correlate fields (older age ↔ higher mortality), use plausible ranges and units,
and include the categorical columns your charts will group by. A few hundred rows
is enough — write them out fully (you may generate them programmatically in your
head or with a throwaway inline loop, but the CSV must be literal in the file).

Column types are inferred (number if all values parse as numbers, else string).
Dates should be strings like `2185-01-17 20:11`; override with `"types"` in the
spec if inference guesses wrong.

## Step 3 — Author spec.json

One JSON file describing the project, datasets, and dashboards. Widgets reference
columns **by header name** — the script remaps them to `col-N`. Full field
reference is the docstring at the top of `assets/build_zip.py`; the essentials:

```json
{
  "appVersion": "2.0.20",
  "project": {
    "projectId": "icu-activity",
    "name": {"en": "ICU Activity", "fr": "Activité de réanimation"},
    "description": {"en": "...", "fr": "..."},
    "readme": "# ICU Activity\n\nDescription...",
    "badges": [{"label": "ICU", "color": "red"}, {"label": "Demo", "color": "blue"}]
  },
  "datasets": [
    {"slug": "icu-stays", "name": "ICU stays", "csv": "icu-stays.csv"}
  ],
  "dashboards": [
    {
      "name": "ICU Activity",
      "filters": [
        {"dataset": "icu-stays", "column": "sex"},
        {"dataset": "icu-stays", "column": "icu_unit", "label": "Unit"},
        {"dataset": "icu-stays", "column": "age"}
      ],
      "tabs": [
        {
          "name": "Demographics",
          "widgets": [
            {"kind": "kpi", "dataset": "icu-stays", "name": "Unique patients",
             "column": "person_id", "uniquePer": "person_id", "aggregate": "count",
             "icon": "Users", "color": "blue"},
            {"kind": "kpi", "dataset": "icu-stays", "name": "ICU mortality",
             "column": "deceased_in_icu", "uniquePer": "person_id",
             "aggregate": "proportion", "targetValue": "1",
             "icon": "HeartPulse", "color": "red", "decimals": 1, "chartType": "pie"},
            {"kind": "plot", "dataset": "icu-stays", "name": "Age distribution",
             "plotType": "histogram", "xColumn": "age", "groupColumn": "sex",
             "binMode": "width", "binWidth": 5, "xLabel": "Age", "yLabel": "Count"},
            {"kind": "plot", "dataset": "icu-stays", "name": "Stays per unit",
             "plotType": "bar", "xColumn": "icu_unit", "uniquePer": "visit_detail_id"}
          ]
        }
      ]
    }
  ]
}
```

### Widget cheatsheet

- **KPI** (`kind: "kpi"`, plugin `linkr-analysis-key-indicator`): one number.
  `aggregate` ∈ `count | mean | median | sum | min | max | proportion`.
  `proportion` needs `targetValue` (string). `uniquePer` de-duplicates rows before
  aggregating (e.g. count unique patients). `chartType` ∈ `none | histogram | pie`.
  `icon` = a Lucide name (`Users`, `BedDouble`, `HeartPulse`, `Calendar`, `Activity`).
  `color` ∈ `blue | red | green | orange | slate | ...`. Optional `unit`, `decimals`,
  `subtitleStats` (e.g. `["median","min","max"]`).
- **Plot** (`kind: "plot"`, plugin `linkr-analysis-plot-builder`): a chart.
  `plotType` ∈ `histogram | bar | line | scatter | box`. `xColumn` required;
  `yColumn`/`groupColumn` optional (grouping auto-enables the legend). Extras:
  `binMode`/`binWidth` (histogram), `barMode` (`stacked`/`grouped`), `xLabel`,
  `yLabel`, `uniquePer`, `showGrid`, `showLegend`, `cardColor`, `opacity`.
- **raw** (`kind: "raw"`): escape hatch. Provide a full `source` object; reference
  columns by `col-N` yourself. Use only when kpi/plot can't express it.

### Dashboard filters (optional)

Add a `"filters"` array on a dashboard. Each entry references a dataset by `slug`
and a column by header `name`; the sidebar renders one input per filter and they
apply across all matching datasets/widgets automatically.

```json
"filters": [
  {"dataset": "icu-stays", "column": "sex"},
  {"dataset": "icu-stays", "column": "icu_unit", "label": "ICU unit"},
  {"dataset": "icu-stays", "column": "age"}
]
```

`type` / `inputType` default from the column type and rarely need overriding:
- `string`/`boolean` → categorical `multi-select`
- `number` → numeric `range`
- `date` → date `range`
Override with `"inputType"` (`checkbox | multi-select | single-select | range | double-range`)
or `"type"` if needed. Optional `"label"` renames the filter in the sidebar.

Layout is automatic: widgets flow left-to-right on a 48-col grid, wrapping rows.
KPIs default to 12×8, plots to 24×16. Override per-widget with `"w"` / `"h"`.
For a 4-across KPI strip use `"w": 12`; a full-width chart is `"w": 48`, half is 24.

## Step 4 — Build the ZIP

```bash
python3 .claude/skills/create-project/assets/build_zip.py spec.json <project-slug>.zip
```

The script prints the project id and counts. It needs only the Python stdlib.

## Step 5 — Verify and hand off

- Sanity-check the ZIP: `unzip -l <out>.zip` should show `project.json`,
  `datasets/<slug>/_data.json`, and `dashboards/<name>.json`.
- Optionally validate the JSON: `python3 -c "import json,zipfile;z=zipfile.ZipFile('out.zip');[json.loads(z.read(n)) for n in z.namelist() if n.endswith('.json')]"`.
- Tell the user the ZIP path and that they import it via the project import flow.
  Every id is regenerated on import, so re-importing makes a fresh copy (no collision).

## Format invariants (do not break)

These mirror `apps/web/src/lib/entity-io.ts` (`buildProjectZip` / `parseProjectZip`).
If that file's layout changes, update `build_zip.py` to match.

- `datasets/_tree.json` = `DatasetFile[]`; each dataset's rows live in
  `datasets/<slug>/_data.json` as `{ "rows": [...] }`, keyed by **column id** (`col-N`).
- `datasets/<slug>/_columns.json` = `DatasetColumn[]` (`{id, name, type, order}`),
  `type` ∈ `string | number | boolean | date | unknown`.
- A dashboard file = `{ "dashboard": Dashboard, "tabs": DashboardTab[], "widgets": DashboardWidget[] }`.
- A widget's `datasetFileId` must equal the target `DatasetFile.id` string (the script
  guarantees this). Widget grid uses `gridV: 2` (48 columns).
- `project.json` carries `appVersion` and omits `readme`/`todos`/`notes` (those go to
  `README.md` / `tasks.json`).
