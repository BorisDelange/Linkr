# Advice for future MCP skills

Lessons from building Linkr content through the MCP server (dashboards, patient boards,
cohorts, IDE scripts), to fold into skills such as a "build a patient board" or "build a
dashboard from a dataset" skill. Each item: the rule, then why.

*Started 2026-10-12.*

## Patient boards

- **One timeline per full row** (`w: 48`). A half-width timeline squeezes the time axis
  until events overlap and the curves are unreadable.
- **Stack timelines one above the other** and turn on `syncTimeRange`, so the same instant
  lines up vertically from one widget to the next (e.g. infection episodes above the
  blood count). Group concepts by scale: heart and respiratory rate together, temperature
  and FiO2 together, not all four on one axis.
- **Several tabs rather than one crowded tab**: one tab per clinical question (e.g.
  *Infections*, *Vital signs*), plus:
  - **Clinical notes on their own tab**, full width and tall: notes need reading room.
  - **Data overview on its own tab, full width**: it lists every source table and concept,
    and is useless when narrow.
- **Patient summary on its own tab** (first tab), not squeezed beside or above a
  timeline.
- One series per item the clinician wants to tell apart (e.g. one row per antibiotic,
  not one "Antibiotics" row with the molecule as text). When the items are not concepts
  of the schema mapping (MIMIC-III `prescriptions` is not an event table), give the
  dataset one column per item and the timeline one dataset entry per column.
- Turn on `sync_timelines_across_tabs` when the tabs are meant to be read together.
- A timeline series read from a dataset must use the **same dates as the database**. A
  dataset whose dates were realigned (e.g. MIMIC de-identification shifts undone for a
  control chart) needs a companion dataset on the database's own dates for the board.

## Dashboards

- Key indicators: a share of patients needs a column that is filled for **every**
  patient (true / false). With `excludeNA`, a column that is empty for the patients
  without the event (e.g. an event-level flag) drops them from the denominator and the
  indicator always reads 100%.
- A share "among patients at risk" (e.g. CLABSI among central line patients) needs a
  column left **empty** for patients not at risk, so `excludeNA` removes them.
- CSV columns spelled "Oui"/"Non" (or yes/no) are read as booleans: the indicator's
  `targetValue` is `"true"`, not `"Oui"`.
- Dashboard filters apply by column name to the other datasets: a dataset without the
  column is not filtered — say so when a filter only covers part of the widgets.
- Control charts: periods at the edge of the data window with few cases blow the limits
  up; trim the window to whole, well-filled periods.

## Cohorts

- `id_list` compares ids as text: on a database where the id column is stored as a
  double (`201504.0`), it matches nothing. Use custom SQL (`WHERE id IN (...)`), or fix the
  comparison (see *Linkr issues* below).
- After `run_cohort`, check the count against the script or dataset it should match.

## IDE scripts

- `sql_query` in the kernel silently stops at 10,000 rows (`MAX_QUERY_ROWS`). Page every
  query (`ORDER BY ALL LIMIT … OFFSET …`) or aggregate in SQL; never trust a row count
  close to 10,000.
- Print aggregates only (counts, rates), never patient-level rows: the output goes to the
  model.

## Linkr issues found on the way

| Issue | Where |
|---|---|
| `sql_query` truncates at 10,000 rows without a warning | `apps/api/app/services/execution/kernel.py`, `db_connect.MAX_QUERY_ROWS` |
| Cohort `id_list` compares as text, misses ids stored as doubles | cohort SQL builder |
| Timeline dataset series sharing a date column got one series id and merged; rows with an empty value/text cell were drawn anyway — **fixed 2026-10-12** (`datasetSeriesKey`) | `lib/patient-data/dataset-timeline.ts` |
