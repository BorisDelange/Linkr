# Databases — cohorts, review board, cohort report, derived databases

Captured and arbitrated 2026-09-23 (§9). **Supersedes [database-page-datamarts-plan.md](database-page-datamarts-plan.md)**:
the "datamart" there is what this plan calls *deriving from a cohort* (§6) — the cohort
*is* the patient selection, so the "cohort vs datamart line" question (datamarts §5.3)
resolves itself: a datamart is a materialised database cohort.

Also absorbs the idea of [cohort-patient-review-plan.md](cohort-patient-review-plan.md),
built first on the database page; the project Cohorts page gets it later if it convinces.

Status legend as in [README.md](README.md): 🔜 ready · 🤔 needs a decision · 💤 later.

---

## 0. What was asked

1. Create **cohorts from the Database page**, like in a project.
2. In a cohort, next to Attrition, a **visualisation tab**: one patient board (tabs +
   widgets, as Patient data), configured once and **saved per database**.
3. **Export a cohort report** (HTML, Word, PDF), modelled on the BELAMI-ICU feasibility
   report, Linkr logo only for now. Named *Cohort report*, not "feasibility study".
4. **Derive from a cohort**: a named schema (`cohort_1234.measurement`…) in an existing
   database (DuckDB, Postgres), or a new DuckDB database — a self-contained copy, vocabulary included — with a choice of location (app files or a
   server folder).
5. **Create from schema**: same location choice.
6. Database **cards show the patient count**.
7. Everything above survives **export → import → versioning** of a database.

## 1. Where we stand (facts from the code, 2026-09-23)

**Cohorts are project-scoped at every layer.** `Cohort.projectUid` required
(`types/cohort.ts:190`); IDB `cohorts` indexed `by-project`; server `cohorts.project_uid`
NOT NULL, FK → `projects.uid` ON DELETE CASCADE; `CohortCreate.project_uid` required; every
route goes through `_require_project_access`; routes live under
`/projects/:uid/warehouse/cohorts` behind `ProjectGuard`.

**But the heavy parts are already host-agnostic.** `builder/CriteriaPanel.tsx` and the whole
`sql/` + `lib/duckdb/cohort-query.ts` builder only need `dataSourceId` + `SchemaMapping`
(no store, no route hook). What is project-bound is the shell: `CohortListPage`,
`CohortBuilderPage` (`useResolvedParams`, `useMyProjectRole`, `useProjectSource`),
`CreateCohortDialog`, `CohortCard`, `use-cohort-actions`. `executeCohort` / `materializeCohort`
live in `cohort-store.ts:338,440`.

**Materialisation today is a frozen id list**, not a table: `materializeCohort` stores
`{ids[], patientIds[]}` as JSON on the cohort. Two defects:
- it calls `queryDataSource`, not `queryDataSourceAll` → **silently cut at 10k rows in
  server mode**;
- `materialization` is **not stripped on export** (client nor server) → patient ids go
  into ZIPs and git repos. For health data that is a leak, not a nicety.

**Patient boards are project-scoped too** (`PatientDashboard.projectUid` required, server FK,
`getByProject`, project permissions). The widgets' data path is already `dataSourceId` +
`schemaMapping` via `PatientChartContext`; what ties them to a project is the owner key, the
role check (`WarehousePluginWidgetRenderer.tsx:24`), `getProjectCohorts` in the patient
sidebar, and datasets/collection (project `datasetsPath`).

**Database page**: `DatabaseDetailPage.tsx` tabs `overview/statistics/schema/readme/license/versioning`
(`:80`), URL tab via `useUrlTab`. Cards (`DatabaseCard.tsx`) show **no stats**.
`DataSource.stats.patientCount` exists (set at create/rebuild by `engine.computeStats`) but
nothing displays it; the richer stats cache is IDB (client) or `/stats-cache` (server) and is
never auto-computed server-side.

**Create from schema**: client = `ATTACH ':memory:'` + DDL re-run at each mount (nothing
persisted); server = `managed_db.create_from_ddl` → fixed `data_path/_databases/<id>.duckdb`.
**No location choice.** A `serverPath` DuckDB is always attached READ_ONLY, and ETL /
compaction require `is_managed(target)` — so a file outside `_databases/` can never be
written today.

**Server path picker** (`server-path-picker-dialog.tsx`) has a folder mode; workspace-scoped
`validate-path?expect=dir` checks *readable* only. The one writable-folder picker is the
project IDE/datasets binding (`FoldersTab.tsx:175`, `validate_binding_path`).

**Report tooling**: none. No docx/pdf lib front or back. `figure-export.ts` serialises
recharts SVG; canvas widgets (dygraphs) only rasterise. Logo: `components/ui/linkr-logo.tsx`
+ `public/favicon.svg`.

**Database export** (`buildDataSourceFolder`, `entity-io.ts:2652` + server twin
`workspace_export_assemble.py:_data_source_sub_tree`) writes `entity.json`, `mapping.json`,
`schema.ddl`, README/LICENSE — no cohorts, no board, no rows. `linkr-format` has a database
serializer (`serialize/database.ts`) and layout.

## 2. Cohorts owned by a database

**Owner model** (D1 ✅): a cohort has **exactly one owner** — a project
(`projectUid`) *or* a database (`ownerDataSourceId`). Not a separate entity: the builder,
SQL, attrition, schema migrations (v5), validator and export shape are identical, and a
second entity would fork all of it.

- Client: `projectUid?`; add `ownerDataSourceId?`; invariant "exactly one" checked in the
  store. IDB v43: index `by-owner-source`. `getDatabaseCohorts(dataSourceId)`.
- Server: Alembic — `project_uid` nullable, `owner_data_source_id` FK → `data_sources.id`
  ON DELETE CASCADE, CHECK (one of the two). Routes: `GET /cohorts?dataSourceId=`,
  create/update/delete gated by `databases:read/write` on the source's workspace instead of
  project permissions.
- For a database cohort, `dataSourceId` == owner (no "pick a database" field).

**Host abstraction** — one `CohortHost` context instead of `useResolvedParams` scattered in
five files:

```ts
type CohortHost =
  | { kind: 'project'; projectUid: string; workspaceId: string }
  | { kind: 'database'; dataSourceId: string; workspaceId: string }
// provides: cohorts list, source + schemaMapping, can(write), paths.cohort(id), create()
```

`CohortListPage` / `CohortBuilderPage` / `CreateCohortDialog` / `CohortCard` /
`use-cohort-actions` consume it; the project routes wrap in a project host, the database
page in a database host. No fork of the builder.

**UI**: a **Cohorts** tab in `DatabaseDetailPage` (workspace mode only, not in
`PROJECT_TAB_IDS`), list → builder at
`/workspaces/:ws/warehouse/databases/:dbId/cohorts/:cohortId` (sub-route, so a cohort is
linkable). Needs the database **connected**; otherwise the connect banner.

💤 later: "Copy to a project" (a database cohort becomes a project cohort — same shape, change
owner).

## 3. Visualisation tab — one patient board per database

**Reuse `PatientDashboard`** with the same owner rule as cohorts (D2 ✅ — this
is option (a) of the cohort-review plan, and the database owner makes "one per database"
natural): `projectUid?` + `ownerDataSourceId?`, one board per database enforced by the
store/route (created lazily on first edit). Tabs + widgets + editor sheet + grid are reused
unchanged.

- `ResultsPanel` gets a third tab `'patients'` (label: *Patients*/*Visualisation*).
- Left: patient list of the **current result** (rows of the last execution, or the
  materialised `patientIds`); right: `PatientChartGrid` in a `PatientChartContext` built
  from the database host.
- Degrade gracefully in a database host: no datasets / collection widgets (they need a
  project `datasetsPath`), no project-cohort filter, role = `databases:write` for edit mode.
  Selection state keyed by `db:<id>` instead of projectUid.
- Patient set addressing (cohort-review §4.1): **in-memory result rows** (already fetched,
  capped at 10k) — enough for review; the SQL-subquery variant is 💤.

Later, the project Cohorts page gets the same tab with a project-owned reserved board.

## 4. Cohort report

A **generated, fixed-template** document — not the BlockNote Reports effort (which is
free-form). They meet later: the report model could become a Reports template.

**Pipeline** — one model, three renderers, all client-side (works in WASM and server mode):

1. `buildCohortReportModel(cohort, mapping, engine)` → plain data (runs the queries).
2. `renderReportHtml(model)` → **one self-contained HTML file** (inline CSS, inline SVG
   charts, logo as data URI, no network) — the BELAMI stylesheet is the reference: A4
   `.page`, KPI grid, tables with tabular nums, print CSS.
3. **PDF** = that same HTML printed (hidden iframe + `print()`, "Save as PDF"): zero
   dependency, and the A4 print CSS is already the design. Server-side PDF (weasyprint /
   headless Chromium) is 💤.
4. **Word** = `docx` (npm, MIT, lazy-loaded) built from the same model; charts embedded as
   PNG rasterised from the same SVG.

Charts are **generated SVG strings** (bars, histogram, flowchart), not captured recharts
DOM — deterministic, identical in all three outputs, testable.

**Sections** (BELAMI → generic, each toggleable in an export dialog):

| # | Section | Source |
|---|---|---|
| — | Header: Linkr logo, "Cohort report", generated at, cohort version, database name | cohort + source |
| 1 | Objective | cohort description (localized) |
| 2 | Counts: patients, visits (KPI cards) | membership SQL |
| 3 | Inclusion flowchart + table (patients **and** visits per step) | attrition queries, extended to count visits |
| 4 | Criteria applied: human-readable definition per criterion | new pure `describeCriterion()` (i18n, tested) |
| 5 | Concepts used: code, vocabulary, label, visits, rows, coverage %, median/visit | concept criteria × cohort |
| 6 | Characteristics: age distribution, sex, admissions per month | patient + visit tables |
| 7 | Available data: rows per event table on the cohort, visits by care site / unit, per year | `eventTables` × membership |
| 8 | Methodology + generated SQL appendix | `buildCohort*Sql` |
| 9 | Legal / small-cell notice | template |

**Small-cell suppression**: counts below a threshold render as `<N` and bars are hidden
(BELAMI uses 11). Threshold in the export dialog, default 11 (D6 ✅). Applied in the model,
so no renderer can forget it.

Tests: `describeCriterion`, suppression, the SVG chart builders, and a golden HTML snapshot of
a fixture model.

## 5. Choosing where a DuckDB file lives (Create from schema + derived databases)

One shared **`DatabaseLocationField`**: *In Linkr's data folder* (today's `_databases/`) or
*In a server folder* (folder picker + file name). Server mode only; client mode keeps
in-memory.

- Backend: a new notion **Linkr-owned file** — Linkr created it, so Linkr may write, rebuild
  and compact it. `managed: true` + optional `serverPath` → `is_managed()` becomes
  `is_owned()` (managed path **or** owned server path). A plain `serverPath` database
  (pointed at existing data) stays READ_ONLY, unchanged.
- `validate-path?expect=writable-dir` on the workspace fs routes (today they check readable
  only), still bounded by `fs_browse_roots`; refuse an existing file unless "overwrite".
- Delete: a database in `_databases/` deletes its file (today); a file created elsewhere is
  **left in place** (the user put it there to keep it) and the confirmation says so.
- Export: `serverPath` already stripped; re-import lands in the managed folder.

## 6. Deriving from a cohort

Arbitrated 2026-09-23 (D3, D4, D9, D10). A derivation is a **self-contained copy**: every
table of the source, filtered on the cohort, **vocabulary included by default** — so the
result is queryable on its own, without the main database. No views onto the parent.

> **Vocabulary.** Here *schema* always means a **SQL schema** (a namespace inside a database:
> `cohort_1234.measurement`), never a Linkr **schema preset** (the data model on the Schema
> presets page, `SchemaMapping`). The UI says "SQL schema" wherever the two could be confused.

One "Derive" dialog, two targets (server mode only, D5):

- **(a) New DuckDB database** — location from §5 (Linkr's folder or a server folder). It is a
  **new database** in every respect: own `id` / `entityId` / fresh `lineageId`, card, stats,
  Patient data, cohorts. It carries the parent's schema preset (`schemaMapping` +
  `schemaSource`), since the tables are the same.
- **(b) New SQL schema in an existing database** — the source itself or another writable one:
  a Linkr-owned DuckDB (§5) or **Postgres** (a connection user with `CREATE` rights). Other
  engines are refused with an explicit message. An option (on by default) also **declares the
  SQL schema as a Linkr database**: a new `DataSource` on the same connection, pointed at that
  namespace (`connectionConfig.schema = cohort_1234`), with the parent's schema preset — so
  the subset is browsable like (a). Unticked, the SQL schema just exists in the target and
  shows in its Schema tab.

**Dialog fields**: target name (SQL schema name, or database name + alias — defaults to
`cohort_<slug>`, editable, validated as an identifier and checked free); person-less tables
(vocabulary, `care_site`, `location`, `cdm_source`…) copied whole, **checked by default**,
with the estimated vocabulary size shown (a full OMOP vocabulary is several GB, and each
derivation copies it).

**Filtering follows the cohort's level** (D9), with the membership of
`buildCohortMembershipSql` — `(id, patient_id)` at the cohort's level
(`patient | visit | visit_detail`; `event` is refused, as materialisation already does):

| Cohort level | Table carrying… | Kept rows |
|---|---|---|
| patient | a patient id | `patient_id IN members` |
| visit | a visit id | `visit_id IN members` (the visits themselves included) |
| visit | a patient id only (person, death, observation_period…) | `patient_id IN members.patient_id` |
| visit_detail | a visit-detail id | `visit_detail_id IN members` |
| visit_detail | a visit id only | the parent visits of the members (visit table), and events of those visits |
| visit_detail | a patient id only | `patient_id IN members.patient_id` |
| any | none of these | copied whole (vocabulary…) or skipped, per the dialog |

Each table is filtered on the **finest id it carries** that is at or above the cohort's
level. Id columns come from the schema preset (`patientTable.idColumn`,
`eventTables[].patientIdColumn` / visit columns, `visitTable`, `visitDetailTable`) — not
hard-coded `person_id`, so MIMIC (`subject_id`, `hadm_id`, `stay_id`) and eHOP work the same.
A table present in the database but absent from the preset is matched by those same column
names; one that carries none is treated as person-less.

🤔 **Open, small**: at `visit_detail` level, an event of the parent visit that carries no
visit-detail id (a lab drawn on the ward after ICU) is kept today by the "visit id only" row.
BELAMI instead kept only events *timed inside* the unit stay. Proposed: keep the parent-visit
rule as default and add a "restrict events to the unit stays' time window" option later (💤).

**Job** — `POST /data-sources/{id}/derive` (reuses the ETL machinery — `run_etl` already
attaches a writable target):
1. freeze the membership (via `queryDataSourceAll`, no 10k cap) into a temp table;
2. attach source READ_ONLY, target writable (new file, or `CREATE SCHEMA <name>` in the target);
3. per table: `CREATE TABLE <target>.<t> AS SELECT * FROM <source>.<t> WHERE <rule above>`;
   the preset DDL's constraints re-applied where the engine supports them;
4. record provenance (below). **Rebuild** re-runs the criteria (drop + recreate the target,
   after confirmation).

**Provenance** (D10). Not `parentLineageId`: that field means *a fork of the same work*
(duplicate / copy-import — `types/author.ts:30-41`) and feeds "same element" detection; a
subset is a new work, and one id could not carry the cohort and criteria anyway. A dedicated
field instead, on the new `DataSource` (and exported, since every piece is a portable ref):

```ts
derivedFrom?: {
  database: DataSourceRef          // parent — {lineageId, entityId, label}, weak ref
  cohort: { key: string; name: LocalizedString }   // cohort key in the parent's export
  level: CohortLevel
  criteriaTree: CriteriaGroupNode  // snapshot: provenance survives the cohort being edited or deleted
  customSql?: string
  builtAt: string
  patientCount: number
  target: 'duckdb' | 'sql-schema'
}
```

`parentLineageId` stays empty on a derived database. On the cohort side,
`derivations[]` (kind, target ref, name, builtAt, patientCount) lets the cohort page show
"derived into …" and offer rebuild — instance state, stripped on export (§8).

Writing into a Postgres warehouse needs `databases:write` **and** a per-database "allow Linkr
to write" toggle, off by default — every source connection is READ_ONLY today.

## 7. Patient count on cards

`DatabaseCard` shows `N patients` from `DataSource.stats.patientCount`, falling back to the
stats cache. Fill `stats.patientCount` with one `COUNT(*)` on the patient table on connect
(client) / on create, rebuild, derive and first connection (server) — not the full stats
compute. Unknown → nothing shown (no spinner on a list page).

## 8. Export / import / versioning

The database export tree gains:

```
databases/<eid>/
  entity.json            # + derivedFrom (portable refs only)
  mapping.json  schema.ddl  README.md  LICENSE.md
  cohorts/<key>.json     # same shape + key scheme as project cohorts (cohortKey)
  patient-board.json     # {patientDashboard, tabs, widgets}, same shape as patient-dashboards/*.json
```

- **Strip `materialization`, `resultCount`, `attrition`, `derivations`** from every cohort
  export — project cohorts included (fixes the patient-id leak of §1).
- Touch in the same change: `buildDataSourceFolder` + import (`parseDatabaseZip`,
  `importParsedDatabase`, `applyClonedDatabase`), server twin
  (`_data_source_sub_tree`, `build_database_tree`), `DatabasePull`, `packages/linkr-format`
  (database layout + `validateCohort` reused under a database tree + the board), golden
  fixtures. The workspace export follows through the database folder.
- Cohort ids on import: `keyId(exportKey)` scoped by the owner database, as for projects.
- A derived database's data is never exported (same as any database); its `derivedFrom`
  pointer is, so a re-import can offer **Rebuild** from the parent.

## 9. Decisions (arbitrated 2026-09-23)

| # | Question | Decision |
|---|---|---|
| D1 | Database cohort = same `Cohort` entity with an owner discriminator, or new entity? | ✅ Same entity |
| D2 | Board = `PatientDashboard` owned by the database, or new entity? | ✅ `PatientDashboard` |
| D3 | Derivation shape | ✅ Self-contained copies of every table, user-chosen name (`cohort_<slug>` default); target = new DuckDB **or** new schema in an existing DB (DuckDB owned by Linkr, Postgres) |
| D4 | Copy person-less tables (vocabulary…)? | ✅ Yes, checked by default (autonomy), can be unchecked |
| D5 | Client-only (WASM) mode: cohorts, board, report yes; derive + location? | ✅ Server only for derive + location |
| D6 | Small-cell threshold default | ✅ 11, editable per export |
| D7 | Permissions for database cohorts / derive / schema-in-source | ✅ `databases:read/write`; writing a schema into a Postgres database also needs its per-database "allow Linkr to write" toggle (§6) |
| D9 | Derivation filtering | ✅ Follows the cohort's level (patient / visit / visit_detail), finest id each table carries, id columns from the schema preset |
| D10 | Provenance of a derived database | ✅ New `derivedFrom` field (parent ref + cohort + criteria snapshot + builtAt); `parentLineageId` not used |
| D8 | Names: tab *Cohorts*, tab *Patients*, *Cohort report* / *Rapport de cohorte*, *Derive* | ✅ as written |

## 10. Steps

Ordered so nothing ships that cannot be exported.

| St | Item | Effort |
|----|------|--------|
| ✅ | Q1. Patient count on database cards (§7) — kept on `stats` after a statistics run; server mode still counts nothing on connect | S |
| ✅ | Q2. Fix `materializeCohort` 10k cap + strip `materialization` from cohort exports (client + server + golden + pull diff + import) | S |
| ✅ | 1. `DatabaseLocationField` + new-file validation + Linkr-owned file (`managedPath`, set once by create-from-ddl), wired into Create from schema | M |
| ✅ | 2. Cohort owner model: types, IDB v43, Alembic, schemas, routes/permissions (§2) — the migration also prepares `patient_dashboards` | M |
| ✅ | 3. `CohortHost` refactor of the cohort shell (project routes keep working) + Cohorts tab on the database page | M/L |
| 🔜 | 4. Export/import/versioning of database cohorts (§8) — client, server twin, linkr-format, goldens | M |
| 🔜 | 5. Board owner model + `'patients'` tab in `ResultsPanel` + patient list of the result (§3) | M/L |
| 🔜 | 6. Board in the database export (§8) | S |
| 🔜 | 7. Report model + `describeCriterion` + small-cell suppression + SVG charts, with tests (§4) | M |
| 🔜 | 8. HTML renderer + export dialog + PDF via print | M |
| 🔜 | 9. Word renderer (`docx`) | M |
| 🔜 | 10. Derive dialog + job: target new DuckDB, self-contained copy, provenance, rebuild (§6a) | L |
| 🔜 | 11. Derive → new schema in a Linkr-owned DuckDB or Postgres (+ write toggle, + register as a database) (§6b) | M/L |
| 🔜 | 12. `docs/architecture.md`, `docs/ui-patterns.md`, user docs in `../linkr-website` (databases + cohorts pages) | S/M |
| 💤 | Same visualisation tab on project cohorts · copy a database cohort to a project · server-side PDF · report branding (logo, colours) | — |
