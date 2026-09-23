# Databases — derived sub-databases (datamarts)

Idea captured 2026-08-22. **Superseded 2026-09-23 by [database-cohorts-plan.md](database-cohorts-plan.md)** — kept for its background (§2, §4).

Derive a **sub-database / datamart** from a main database by selecting patients
exactly as the cohort builder does, then projecting every event table onto that
patient set.

Status legend as in [README.md](README.md): 🔜 ready · 🤔 needs a decision · 💤 later.

---

## 1. Where we stand

**The page with tabs is done.** `DatabaseDetailPage.tsx` replaced the old
right-hand `DatabaseDetailSheet` (the sheet is gone, not kept alongside — two
surfaces showing the same thing was the divergence risk `docs/ui-patterns.md` §6
is about). Its tabs today: *Overview*, *Statistics*, *Schema* (inline, no longer a
dialog-inside-a-sheet), plus the shared secondary tabs README / License /
Versioning. What this plan still adds to it is a **Datamarts** tab, and possibly a
**Data quality** one (§3).

**There is no notion of a sub-database today.** One `DataSource` = one flat namespace.
`DataSource.alias` becomes the DuckDB attach/schema name (`types/index.ts:328-329`),
`DatabaseConnectionConfig.schema` is a single free-text Postgres schema name, and
`SchemaMapping` / `CustomSchemaPreset` describe a *data model*, not a physical subset.

## 2. Why sub-databases

A recurring need with hospital data warehouses: from the main warehouse, carve out a
working subset — one study, one department, one time window — that analysts query
without touching (or being able to touch) the whole base. Call it a datamart, a
sub-database, a study base; the operation is the same: **select patients, then
project every event table onto that patient set.**

Naming to settle (§5.1). This plan uses **datamart** provisionally.

## 3. The two tabs still to add

| Tab | Content | Reuses |
|---|---|---|
| Datamarts | list + builder (§4) | cohort builder components |
| Data quality | apply a DQ rule set to this database and see the result | the DQ rule-set entity |

The Data quality tab is the least settled — DQ rule sets exist as an entity, but
whether a *database* page is the right place to run them (vs the existing Data quality
page, which is project-scoped) needs deciding. Marked 🤔 below.

## 4. Datamarts — reuse the cohort builder, near-identically

The selection half is *the same problem the cohort builder already solves*: a
recursive `CriteriaTreeNode` over 8 criteria types, level-aware
(`patient | visit | visit_detail | event`), executed against `schemaMapping`
(`types/cohort.ts`). What differs is only what happens with the resulting patient set.

So: **extract the criteria builder from the cohort feature into a shared component**
(`CriteriaPanel` + `CriteriaGroupNodeComponent` + `CriterionCard` + the `criteria/`
forms), parameterised by what the consumer does with the result. Extract, do not fork —
the ATLAS converter, the level selector and the concept picker must not exist twice.

Two output modes once the patient set is selected:

- **(a) New database** — materialise the filtered tables into a new `DataSource`
  (Parquet folder, per the standing "database copies as Parquet, never DuckDB" rule in
  `docs/architecture.md`), with its own alias, statistics and schema mapping inherited
  from the parent.
- **(b) New schema inside the main database** — create a schema in the source database
  holding the filtered tables. Server-mode and engine-dependent (needs write rights on
  the warehouse, which a hospital DSI may well refuse); DuckDB and Postgres can, a
  read-only Oracle mirror cannot.

Both need the same core: **from a patient set, project every event table**. That is
`schemaMapping.eventTables` iterated with an `IN (person set)` filter — the same shape
`buildOverviewInventoryQuery` already uses (`lib/duckdb/patient-overview-queries.ts:56-64`).

**Provenance matters here.** A datamart must record its parent source, its criteria
tree and the date it was built, or nobody can tell six months later what the subset
actually is. Since the criteria tree is stored, the datamart is also *re-buildable*.

## 5. Open questions

1. **Naming** — datamart / sub-database / study base / extract? It ends up in the UI,
   the URL and the entity name, so settle before building.
2. **Is a datamart a `DataSource` or its own entity?** A `DataSource` with a
   `derivedFrom` pointer buys the whole existing stack (list, stats, schema browser,
   project linking, active-source selection). Leaning yes.
3. **Datamart vs cohort — where does the line sit?** A cohort is a patient list; a
   datamart is a queryable base. But a materialised cohort
   (`CohortMaterialization`, `types/cohort.ts:208`) is close to mode (b). Risk of two
   overlapping features; worth one paragraph of arbitration before writing code.
4. **Mode (b) permissions** — writing a schema into the production warehouse is a
   privileged act. Needs its own permission and probably an instance-level switch, as
   `LINKR_ALLOW_REMOTE_LLM` does for LLMs.
5. **Export / versioning** — does a datamart definition (criteria + parent pointer,
   not the data) travel with the workspace export? It should, and it is cheap: it is
   just a criteria tree.

## 6. Steps

| St | Item | Effort |
|----|------|--------|
| ✅ | Database detail **page** with tabs (Overview / Statistics / Schema), sheet retired | M |
| 🤔 | Arbitrate naming, entity shape, and the cohort/datamart line — §5.1-5.3 | S (decision) |
| 🔜 | Extract the cohort criteria builder into a shared, consumer-agnostic component | M |
| 🔜 | Datamart entity + builder tab + provenance (parent, criteria, built-at) | L |
| 🔜 | Mode (a): materialise to a new Parquet-backed `DataSource` | M |
| 🤔 | Mode (b): create a schema in the source database (permission + engine support) | L |
| 🤔 | Data quality tab: run a DQ rule set against the database | M |
