# Dashboard

A dashboard has tabs; tabs hold widgets; a widget renders one dataset through a plugin
(or inline code). Filters live on the dashboard and apply across widgets.

Field lists: `describe_entity_schema("dashboard" | "tab" | "widget")`. This page covers
what those cannot tell you — **which plugin to reach for and what it expects**.

## Reference columns by NAME

Everywhere a config takes a column, write the **header name** (`age`, not `col_age`).
The writer resolves it. An unresolved name renders a blank widget with an empty column
picker and no error anywhere — the single most common way a hand-built dashboard fails.

## The nine built-in Lab plugins

There is no native markdown, image or iframe widget. Use these rather than inventing
something with inline code.

| pluginId | What it does |
|---|---|
| `linkr-analysis-key-indicator` | one KPI value + icon + optional mini-chart |
| `linkr-analysis-plot-builder` | histogram / bar / line / scatter / box / violin |
| `linkr-analysis-table1` | descriptive "Table 1", optional group-by |
| `linkr-analysis-correlation-matrix` | correlation heatmap |
| `linkr-analysis-statistical-tests` | group-comparison tests |
| `linkr-analysis-regression` | linear / logistic regression, forest plot |
| `linkr-analysis-kaplan-meier` | survival curves |
| `linkr-analysis-map` | geographic point map |
| `linkr-analysis-sankey` | flow / Sankey diagram |

### Config keys that take columns

Single = a name; multi = an array of names. Everything else passes through verbatim.

- **key-indicator** — `column`, `uniquePer`. Also `aggregate` ∈
  `count|mean|median|sum|min|max|proportion`; `proportion` needs `targetValue` (a
  string, e.g. `"1"`). `uniquePer` de-duplicates before aggregating — count unique
  patients across several stays. Plus `icon` (a Lucide name), `color`, `unit`,
  `decimals`, `chartType` ∈ `none|histogram|pie`, `subtitleStats`.
- **plot-builder** — `xColumn` (required), `yColumn`, `groupColumn`, `uniquePer`. Also
  `plotType` ∈ `histogram|bar|line|scatter|box`, `binMode`/`binWidth`, `barMode` ∈
  `stacked|grouped`, `xLabel`, `yLabel`, `showGrid`, `showLegend`, `colorPalette`.
- **table1** — `selectedColumns` (multi), `groupByColumn`. Also `metrics` ∈
  `n|missing|mean_sd|median_iqr|min_max|range|categories`.
- **correlation-matrix** — `selectedColumns` (multi). Also `method` ∈
  `pearson|spearman`, `showValues`, `showSignificance`, `alpha`.
- **statistical-tests** — `valueColumns` (multi), `groupColumn`. Also `testPreference` ∈
  `auto|nonparametric|parametric`, `alpha`, `visibleColumns`.
- **regression** — `predictorColumns` (multi), `outcomeColumn`. Also `regressionType` ∈
  `auto|linear|logistic`, `confidenceLevel`, `showForestPlot`, `visibleColumns`.
- **kaplan-meier** — `timeColumn`, `eventColumn`, `groupColumn`. Also `confidenceLevel`,
  `showCI`, `showAtRisk`, `showMedian`, `showCensor`, `timeLabel`.
- **map** — `latColumn`, `lonColumn`, `colorColumn`, `sizeColumn`, `labelColumn`,
  `popupColumns` (multi). Also `basemap` ∈ `osm|carto-light|carto-dark|none`,
  `pointSize`, `opacity`.
- **sankey** — `entityColumn`, `stageColumn`, `orderColumn`, `pathColumn`,
  `levelColumns` (multi). Also `sourceMode` ∈ `long|levels|path`, `pathSeparator`,
  `displayMode`, `valueDisplay`.

## Layout

The grid is **48 columns**. Omit `layout` and widgets flow left-to-right, wrapping —
which is what you usually want, since hand-placing everything is tedious and overlaps
render as stacked cards with no warning.

Size with `w`/`h` instead: a KPI strip of four is `w: 12` each, a half-width chart is
24, full width 48. KPIs default to 24×16 like everything else, so **set `w: 12, h: 8`
on KPIs** or they will be enormous.

Give `layout: {x, y, w, h}` explicitly only when a precise arrangement matters. The
validator rejects anything spanning past column 48.

## Filters

`{dataset, column, label?, inputType?}`. Type is derived from the column: number → a
numeric range, date → a date range, anything else → a categorical multi-select. Override
only when the derived choice is wrong — a range over a categorical column offers no
usable values.

## Tabs

One level of nesting: a tab may have a `parent` (the parent's English name). A tab with
children still holds its own widgets — unlike the older builder, which forbade it.

## Inline code widgets

Give `code` and `language` (`python` | `r`) instead of a `pluginId`. Reference columns
by **id** (`col_age`) inside the code — the writer does not rewrite code bodies, only
config values.

## Pitfalls

- KPIs without `w`/`h` take a full plot-sized slot.
- `proportion` without `targetValue` renders nothing.
- A widget naming a tab that does not exist imports and then never appears; the
  validator catches it as `orphan-record`.
