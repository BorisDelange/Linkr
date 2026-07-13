# Reference — dashboards (KPIs, charts, filters)

A dashboard has tabs; each tab has widgets. Widgets reference a dataset by `slug`
and columns by **header name** — the script remaps names → `col-N`.

```json
"dashboards": [
  {
    "name": "ICU Activity",
    "showWidgetTitles": false,
    "filters": [
      {"dataset": "icu-stays", "column": "sex"},
      {"dataset": "icu-stays", "column": "icu_unit", "label": "Unit"},
      {"dataset": "icu-stays", "column": "age"}
    ],
    "tabs": [
      {
        "name": "Demographics",
        "widgets": [ /* see cheatsheet */ ]
      }
    ]
  }
]
```

## Widget cheatsheet

### KPI — `kind: "kpi"` (plugin `linkr-analysis-key-indicator`)
One number, optionally with a mini chart.

```json
{"kind": "kpi", "dataset": "icu-stays", "name": "Unique patients",
 "column": "person_id", "uniquePer": "person_id", "aggregate": "count",
 "icon": "Users", "color": "blue"}
```

- `aggregate` ∈ `count | mean | median | sum | min | max | proportion`.
- `proportion` requires `targetValue` (string), e.g. mortality:
  `"aggregate": "proportion", "targetValue": "1", "column": "deceased_in_icu"`.
- `uniquePer` de-duplicates rows before aggregating (e.g. count unique patients
  across multiple stays). Header name.
- `chartType` ∈ `none | histogram | pie`.
- `icon` = a Lucide name (`Users`, `BedDouble`, `HeartPulse`, `Calendar`,
  `Activity`, `Stethoscope`, `Syringe`…). `color` ∈ `blue | red | green | orange
  | slate | purple | teal | …`.
- Optional: `unit`, `decimals`, `subtitleStats` (e.g. `["median","min","max"]`).

### Plot — `kind: "plot"` (plugin `linkr-analysis-plot-builder`)
A chart.

```json
{"kind": "plot", "dataset": "icu-stays", "name": "Age distribution",
 "plotType": "histogram", "xColumn": "age", "groupColumn": "sex",
 "binMode": "width", "binWidth": 5, "xLabel": "Age", "yLabel": "Count"}
```

- `plotType` ∈ `histogram | bar | line | scatter | box`.
- `xColumn` required; `yColumn` / `groupColumn` optional (grouping auto-enables
  the legend). All are header names.
- Extras: `binMode`/`binWidth` (histogram), `barMode` (`stacked`/`grouped`),
  `xLabel`, `yLabel`, `uniquePer`, `showGrid`, `showLegend`, `cardColor`,
  `opacity`, `colorPalette`.

### raw — `kind: "raw"` (escape hatch)
Provide a full `source` object and reference columns by `col-N` yourself. Use
only when kpi/plot can't express it.

```json
{"kind": "raw", "dataset": "icu-stays", "name": "Custom",
 "source": {"type": "plugin", "pluginId": "…", "config": { /* col-N refs */ }}}
```

## Filters (optional)

Each entry references a dataset by `slug` and a column by header `name`; the
sidebar renders one input per filter and applies it across all matching
datasets/widgets automatically.

`type` / `inputType` default from the column type and rarely need overriding:
- `string`/`boolean` → categorical `multi-select`
- `number` → numeric `range`
- `date` → date `range`

Override with `"inputType"` (`checkbox | multi-select | single-select | range |
double-range`) or `"type"`. Optional `"label"` renames the filter.

## Layout

Automatic: widgets flow left-to-right on a **48-column** grid, wrapping rows.
KPIs default to 12×8, plots to 24×16. Override per-widget with `"w"` / `"h"`.
A 4-across KPI strip uses `"w": 12`; a full-width chart is `"w": 48`, half is 24.

## Invariants (mirror entity-io.ts)

- A dashboard file = `{ "dashboard": Dashboard, "tabs": DashboardTab[],
  "widgets": DashboardWidget[] }`.
- A widget's `datasetFileId` must equal the target `DatasetFile.id` (the script
  guarantees this). Widget grid uses `gridV: 2` (48 columns).
