# Descriptive table & Statistical tests — rework

Status: in progress (started 2026-08-23)

Reworks the two oldest analysis plugins, `table1` and `statistical-tests`. Both
predate the column-metadata work and the config-panel conventions the other
plugins (KPI, Plot Builder, Survey) now follow.

## 1. Why they are two plugins, not one

The tempting move is to merge them — gtsummary, the R reference, puts the
p-value inside the descriptive table. The reason to keep them apart is that they
differ in their **unit of reading**, not in their subject:

- **Descriptive table**: one row = one VARIABLE, one column = one GROUP. Read
  ACROSS, to compare groups. It is a publication object.
- **Statistical tests**: one row = one TEST, and the columns are the test's
  components (statistic, df, effect size, CI, warning). Read DOWN, to audit the
  method. It is a working object.

That difference decides their UI. A working table legitimately has filters,
sorting and a column-visibility menu; a publication table must have none of
them. Only the first is a bespoke component (§3).

The descriptive table still gains a **p-value column** when a group-by is
active, because that is what a journal's Table 1 carries. The details behind
that p-value live in a tooltip rather than a footnote (§4).

## 2. Naming

"Table 1" is an idiom of medical publishing: in an article, table 1 is *by
convention* the one describing the population. It names a POSITION IN A PAPER,
not what the tool does, and means nothing to someone who does not publish in
clinical journals — and in Linkr the table need not be first at all.

Renamed to **Descriptive table** / **Tableau descriptif**. `table1` stays in
`tags` so search still finds it, and the plugin id is unchanged so existing
analyses keep working.

## 3. A publication table, not a datatable

Decided 2026-08-23: this does NOT reuse `ConceptDataTable`. That component
exists to EXPLORE data — inline filter fields under every header, a
column-visibility menu, paging controls, a row counter. Every one of those is
chrome that must not appear in a manuscript, so reusing it would mean fighting
it to hide most of what it does. `ui-patterns.md` §6 says extend the shared
component when it *almost* fits; here it does not — the goal is a typeset table.

(The extensions already made to `ConceptDataTable` — `pinned`, `stickyHeader`,
`density`, `align`, `cellClassName` — stand on their own: they were real gaps,
and the other 16 tables can use them.)

### 3.1 Style — booktabs

The convention of biomedical journals, and what LaTeX `booktabs`, `gtsummary`
and the NEJM/Lancet produce:

- horizontal rules ONLY: top, under the header, bottom;
- **no vertical rules**, no zebra striping, no cell borders;
- no wrapping: one line per row, ellipsis + tooltip past the width (§3.3).

### 3.2 Categorical variables — one indented row per level

The gtsummary convention, and what a journal's Table 1 looks like:

```
Type de service
   Réanimation      44 (24%)
   USC              62 (34%)
   USI              75 (41%)
```

Not all levels stacked into one cell, which is what the plugin does today: it
does not read, and it does not copy into a document as a table.

### 3.3 One line per row

Default: no wrapping, ellipsis past the width, full text on hover. Irregular row
heights break the vertical scan that is the whole point of a column of figures.
Configurable, since a long category label is sometimes worth two lines.

### 3.4 Column resizing

Kept — a variable-name column often needs widening. Implemented on the bespoke
table with the shared `ResizeGrip` from `table-primitives` (headless, made for
exactly the tables that track their own widths).

## 4. Test selection: automatic, transparent, overridable

### 4.1 What no-code stats tools do

| Tool | Test choice |
|---|---|
| gtsummary (R) | Automatic by default, overridable per variable |
| JASP / jamovi | User picks; the tool warns when assumptions fail |
| GraphPad Prism | A wizard ASKS (paired? gaussian?) |
| SPSS | User picks everything, no assistance |

The modern line — gtsummary, jamovi — is **automatic + transparent +
overridable**, and reporting guidance (SAMPL) is explicit that a p-value must
never appear without the test that produced it.

### 4.2 What we have, and what is wrong with it

`selectTest()` already encodes a genuine clinical rule (Fisher when a 2×2 has an
expected count < 5). But the `auto` preference **never tests normality**: for
two groups it always returns Welch. Calling that "auto" promises a judgement the
code does not make.

### 4.3 Decided

- `auto` becomes data-driven: **Shapiro-Wilk** decides Welch vs Mann-Whitney.
- The **tooltip on the p-value** states the test, WHY it was chosen, the
  statistic, and any warning.
- **Per-variable override**, so a user who knows their data can force a test.
- A fragile p-value is **shown with a warning marker**, never hidden: hiding a
  result leaves the reader unable to see there was anything to know.

## 5. Config panel

Realigned on the KPI / Plot Builder / Survey conventions: sections, booleans
grouped by `row`, `optionHint` where a column picker needs describing. Uses
column LABELS (`displayColumnName`) rather than storage names — a descriptive
table is made to be read and exported, so technical ids make it unusable as-is.

## 6. Export

An **Export button beside Cancel / Save** in the analysis shell, so every
analysis can export what suits it. Formats offered per analysis type:

- **PNG** — reusing `features/projects/dashboard/figure-export.ts`
  (`nodeToBlob`, `sanitizeFilename`; `DEFAULT_DPI` is 192, i.e. 2×). Note
  `findWidgetNode` keys off `[data-widget-id]`, which the analyses page does not
  set — pass the node directly instead.
- **Copy to clipboard** — as a real table, so it pastes into Word / Google Docs
  with its structure intact.
- **LaTeX (booktabs)** — the style in §3.1 transcribes to it directly.

## 7. Server parity

Both plugins have a server render. Labels, metrics and test selection must match
client and server, with parity tests, as was done for `survey-question`.

## Open

- (a) Whether the descriptive table should offer a "stratified" mode (a second
  grouping nested under the first). Common in papers, but doubles the header
  complexity — deferred until asked for.
- (b) Whether Statistical tests should also get the booktabs style. It is a
  working object (§1), so probably not; revisit once the descriptive table
  exists.
