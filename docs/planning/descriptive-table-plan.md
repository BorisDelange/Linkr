# Descriptive table & Statistical tests — remaining work

Status: **the rework shipped (started 2026-08-23).** Both plugins were brought onto
the column-metadata and config-panel conventions the newer plugins follow. What is
left is the p-value column in the descriptive table, and one deferred decision.

## 1. Shipped (as-built)

- **Renamed** to *Descriptive table* / *Tableau descriptif* — "Table 1" names a
  POSITION IN A PAPER, not what the tool does. `table1` stays in `tags` so search
  still finds it, and the plugin id is unchanged so existing analyses keep working
  (`analyses/table1/plugin.json`, v2.0.0).
- **A publication table, not a datatable** — `components/ui/publication-table.tsx`,
  bespoke because a publication table must carry no filters, sorting or
  column-visibility menu. Rows indent by modality; `wrap` is configurable, off by
  default.
- **Shared beyond this plugin**: statistical tests, regression and Kaplan-Meier all
  moved onto `PublicationTable` too, so they get the booktabs rules, resizable
  columns and truncation for free — sharing one table component beat keeping a
  second styling path for one plugin (settled (b)).
- **`auto` is data-driven** — Shapiro-Wilk (Royston 1992) decides Welch vs
  Mann-Whitney: `lib/stats/normality.ts`, with `normality.test.ts` pinned against R
  reference values. Per-variable override via `lib/stats/applicable-tests.ts`; the
  picker outranks the global preference and is ignored — not erased — when the group
  count changes so it no longer applies.
- **Export** PNG / clipboard / LaTeX booktabs (`lib/table-export.ts`).
- **Server parity** for both plugins (`render/table1.py`, `render/statistical_tests.py`,
  `tests/test_render.py`), and the business logic extracted to `lib/stats/descriptive-table.ts`.

## 2. Why they stayed two plugins

The tempting move is to merge them — gtsummary, the R reference, puts the p-value
inside the descriptive table. They stay apart because they differ in their **unit of
reading**, not their subject: a descriptive table is one row per VARIABLE, read
ACROSS to compare groups (a publication object); statistical tests are one row per
TEST, read DOWN to audit the method (a working object). That difference is what
decides their UI.

## 3. Remaining

| St | Item | Effort |
|----|------|--------|
| 🔜 | **p-value column in the descriptive table** when a group-by is active — that is what a journal's Table 1 carries. `render/table1.py` emits no p today (only `statistical_tests.py` does), so this is client + server + parity test | M |
| 🔜 | **The tooltip behind that p-value**: the test, WHY it was chosen, the statistic, and any warning. Reporting guidance (SAMPL) is explicit that a p-value must never appear without the test that produced it, and `normality.ts` already returns the `w` / `pValue` / `reason` needed to say so. A fragile p-value is **shown with a warning marker, never hidden** — hiding a result leaves the reader unable to see there was anything to know | S |
| 🤔 | Stratified mode (a second grouping nested under the first). Common in papers, but doubles the header complexity — deferred until asked for | M |
