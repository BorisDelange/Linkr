# Cohorts — patient review tab

Idea captured 2026-08-22. Not yet arbitrated.

Add a tab **after Attrition** in the cohort results pane that shows the patient
records of the current result set, reusing the Patient data machinery (tabs +
widgets) — but with **one single configuration per project**, not several boards.

Status legend as in [README.md](README.md): 🔜 ready · 🤔 needs a decision · 💤 later.

---

## 1. Why

Today, looking at the actual charts behind a query means **materialising a cohort
first**: create it, execute it, browse Patient data, then delete the cohort if the
query was wrong. The review loop runs through an entity you did not want to keep.

A review tab makes the loop non-destructive: run the criteria, look at the patients,
adjust the criteria, look again. The cohort is created only when the definition is
good.

## 2. Where it plugs in

`results/ResultsPanel.tsx:20` already holds the tab state
(`useState<'results' | 'attrition'>`) with the buttons at l.84-107 — a third value
`'review'` and a third button, rendering a new panel next to `ResultsTable` and
`AttritionChart`.

The panel needs a **patient selector** (the results tab already lists the matched
`person_id`s) driving the same `PatientChartContext` the Patient data page uses:
`personId` / `visitOccurrenceId` / `visitDetailId` / `dataSourceId` /
`schemaMapping` are exactly `PatientComponentPluginProps`
(`lib/plugins/patient-component-registry.ts:15-25`), so any patient-data widget
renders unchanged.

The cohort builder already resolves the active source and passes
`activeSource.schemaMapping` into execution (`CohortBuilderPage.tsx:71-72, 150`) —
the same two values feed the review widgets. Nothing new on the data path.

## 3. One configuration per project (the actual design question)

Patient data now has `PatientDashboard`, several boards per project. The review tab
deliberately has **one**: it is a lens on the current query, not a deliverable.

Two ways to get there, to arbitrate:

- **(a) A reserved `PatientDashboard`** flagged e.g. `kind: 'cohort-review'`, one per
  project, hidden from the Patient data board picker. Buys the whole existing stack
  for free — persistence, export, versioning, the widget kebab, the config panel —
  at the cost of one discriminator field and the care to keep it out of pickers.
- **(b) A distinct lightweight entity** (`CohortReviewBoard`) with its own tabs and
  widgets. Cleaner semantically, but re-implements storage, export, the Python twin
  and a golden fixture for something that is structurally identical.

**Leaning (a)** — the "no complex backcompat / reuse rather than fork" preference
points there, and `docs/ui-patterns.md` §6 says extend the shared component rather
than clone it. The one thing to check first is whether the export/import key scheme
(`patient-dashboards/{slug}.json`) stays stable when one board is special: it should,
since the key is derived from the name, but a reserved slug is worth pinning.

Either way the board is **project-scoped and travels with the project**, like the
patient boards themselves (patient-data-plan §9.1).

## 4. Open questions

1. Does the review tab work on the **transient execution result** only, or also on a
   materialised cohort? (Transient is the point — but `CohortExecutionResult` is
   explicitly transient in `types/cohort.ts:236`, so paging through thousands of
   person_ids needs a decision: keep the id list in memory, or re-run the cohort SQL
   as a subquery for each widget.)
2. **Widget scoping**: patient widgets take one `personId`. Should the review tab also
   offer *cohort-level* widgets (distribution of an event across the matched set)? That
   is a different props contract and probably a separate effort — note it, don't build it.
3. Where does the configuration UI live — an edit mode inside the tab, or a link to a
   dedicated settings surface? (Edit mode inside the tab is consistent with Patient data.)

## 5. Steps

| St | Item | Effort |
|----|------|--------|
| 🤔 | Arbitrate (a) reserved `PatientDashboard` vs (b) new entity — §3 | S (decision) |
| 🤔 | Arbitrate how the patient set is addressed (in-memory ids vs SQL subquery) — §4.1 | S (decision) |
| 🔜 | `'review'` tab in `ResultsPanel` + patient selector wired to `PatientChartContext` | M |
| 🔜 | Board configuration (edit mode, add/configure widgets) reusing `PatientChartGrid` | M |
| 💤 | Cohort-level (aggregate) widgets — separate props contract, separate effort | L |
