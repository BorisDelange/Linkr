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

## Sub-tabs (one level of nesting)

A tab is either a **leaf** (holds widgets directly) or a **container** (nests
sub-tabs). Nesting is **ONE level only** — a sub-tab may not itself contain
`tabs` (the script raises an error). A container holds **no widgets of its own**;
its widgets live in the sub-tabs. To nest, just put a `"tabs"` array inside a tab
instead of `"widgets"` — the wiring (`parentTabId` on each sub-tab, per-parent
`displayOrder`) is automatic.

```json
"tabs": [
  {
    "name": "Demographics",
    "widgets": [ /* leaf tab — widgets directly */ ]
  },
  {
    "name": "Outcomes",
    "tabs": [
      {"name": "Mortality",      "widgets": [ /* sub-tab widgets */ ]},
      {"name": "Length of stay", "widgets": [ /* sub-tab widgets */ ]}
    ]
  }
]
```

Emitted `DashboardTab`s carry `parentTabId`: `null` for root tabs (leaf or
container), and the container's id for each sub-tab. Widgets always reference
their own (sub-)tab via `tabId`; layout is per-(sub-)tab on the 48-column grid.

## Built-in widget inventory

A Lab dashboard widget is one of two `source.type`s: **`plugin`** (a registered
built-in) or **`inline`** (user Python/R/SQL code). There is **no** native
markdown/image/iframe widget. These are ALL 8 built-in Lab plugins — use them,
don't reinvent with `raw`:

| pluginId | What it does | spec `kind` |
|----------|--------------|-------------|
| `linkr-analysis-key-indicator` | Single KPI value + icon + optional mini-chart | `kpi` (shortcut) |
| `linkr-analysis-plot-builder` | scatter / line / bar / histogram / box / violin | `plot` (shortcut) |
| `linkr-analysis-table1` | Descriptive "Table 1" (n, mean±sd, median[IQR]…), optional group-by | `plugin` |
| `linkr-analysis-correlation-matrix` | Correlation heatmap (pearson/spearman) | `plugin` |
| `linkr-analysis-statistical-tests` | Group-comparison tests (t/Mann-Whitney/χ²…) | `plugin` |
| `linkr-analysis-regression` | Linear / logistic regression, forest plot | `plugin` |
| `linkr-analysis-kaplan-meier` | Survival curves | `plugin` |
| `linkr-analysis-map` | Geographic point map | `plugin` |
| `linkr-analysis-sankey` | Flow / Sankey diagram | `plugin` |

`kpi` and `plot` have dedicated ergonomic shapes (below). The other six use the
generic **`kind: "plugin"`** shape: give `pluginId` + a `config` object where
column-select keys are **header names** (the script resolves them to `col-N`).

### Generic plugin widget — `kind: "plugin"`

```json
{"kind": "plugin", "pluginId": "linkr-analysis-table1", "dataset": "icu-stays",
 "name": "Baseline characteristics",
 "config": {
   "selectedColumns": ["age", "sex", "sofa_score"],   // multi column → col-N array
   "groupByColumn": "deceased_in_icu",                // single column → col-N
   "metrics": ["n", "mean_sd", "median_iqr"]          // non-column → verbatim
 }}
```

Column-select keys per plugin (given as header names; single = string,
multi = array). Everything else in `config` is passed through verbatim.

- **table1** — cols: `selectedColumns` (multi), `groupByColumn`. other:
  `metrics` ∈ `n|missing|mean_sd|median_iqr|min_max|range|categories`.
- **correlation-matrix** — cols: `selectedColumns` (multi). other:
  `method` ∈ `pearson|spearman`, `showValues`, `showSignificance`, `alpha`.
- **statistical-tests** — cols: `valueColumns` (multi), `groupColumn`. other:
  `testPreference` ∈ `auto|nonparametric|parametric`, `alpha`,
  `visibleColumns` ∈ `test|statistic|df|p|ci|effectSize|descriptive`.
- **regression** — cols: `predictorColumns` (multi), `outcomeColumn`. other:
  `regressionType` ∈ `auto|linear|logistic`, `confidenceLevel`, `showForestPlot`,
  `visibleColumns` ∈ `estimate|se|ci|statistic|p`.
- **kaplan-meier** — cols: `timeColumn`, `eventColumn`, `groupColumn`. other:
  `confidenceLevel`, `showCI`, `showAtRisk`, `showMedian`, `showCensor`, `timeLabel`.
- **map** — cols: `latColumn`, `lonColumn`, `colorColumn`, `sizeColumn`,
  `labelColumn`, `popupColumns` (multi). other: `basemap` ∈
  `osm|carto-light|carto-dark|none`, `pointSize`, `opacity`, `colorPalette`.
- **sankey** — cols: `entityColumn`, `stageColumn`, `orderColumn`, `pathColumn`,
  `levelColumns` (multi). other: `sourceMode` ∈ `long|levels|path`, `pathSeparator`,
  `displayMode` ∈ `diagram|table|both|both-tabs`, `valueDisplay` ∈ `none|count|percent`.

Default sizes: table1 & tests & regression → 48 wide; correlation-matrix → 24×24;
others → 24×16. Override with `"w"`/`"h"`.

### Inline code widget — `kind: "inline"`

User-authored code, no plugin. `language` ∈ `python | r | sql` (SQL is only
meaningful for DB-backed datasets). Reference columns by col-N in your code.

```json
{"kind": "inline", "dataset": "icu-stays", "name": "Custom",
 "language": "python", "code": "print(df.describe())"}
```

## Widget cheatsheet — KPI & plot shortcuts

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

### raw — `kind: "raw"` (last-resort escape hatch)
Provide a full `source` object and reference columns by `col-N` yourself. Rarely
needed now that `kind: "plugin"` covers every built-in — use it only for a
pluginId not in the inventory above, or a hand-crafted source.

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
