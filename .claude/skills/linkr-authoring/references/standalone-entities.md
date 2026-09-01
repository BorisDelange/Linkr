# Standalone entities

Six kinds live in their **own** folder or repo rather than inside a project, and are
written with `write_entity(path, kind, spec)`. This is the shape the
`linkr-public-content` repos use — one repo per entity.

Field lists: `describe_entity_schema(kind)`. This page covers what those cannot say.

Every kind writes the same manifest name, **`entity.json`**, which declares what it is in
its `type` field. Substantial payload lives in its own file beside the manifest, so the
identity a human opens the file for is not buried under it.

| Kind | What it is | Files it produces |
|---|---|---|
| `sql-collection` | reusable SQL queries | `entity.json` + `scripts/_tree.json` + `scripts/*.sql` |
| `etl-pipeline` | ordered SQL that builds a target database | `entity.json` + `scripts/_tree.json` + `scripts/*.sql` |
| `dq-rule-set` | data-quality checks run against a database | `entity.json` + `checks.json` |
| `data-catalog` | counts over chosen dimensions | `entity.json` |
| `mapping-project` | local codes aligned to OMOP concepts | `entity.json` + `mappings.json` |
| `schema-preset` | how to read one database's tables | `entity.json` + `mapping.json` + `schema.ddl` |

All of them also take `README.md` / `LICENSE.md` at the root.

What is **not** here: cohorts, dashboards and patient-data views belong to a project and
have no standalone export. Dashboards are written as part of `write_project`; cohorts are
covered at the end of this page.

## SQL collections and ETL pipelines

Same shape; the difference is intent. A collection is a drawer of queries someone opens
one at a time; a pipeline is an **ordered** sequence that builds something, so the `order`
field and the file naming carry meaning — number them (`01_person.sql`, `02_visit.sql`).

Folders are declared in `scripts/_tree.json` automatically. Do not write that file
yourself: a file whose parent folder is missing gets reparented to the root on import,
silently flattening the layout.

## DQ rule sets

Each check is a **SQL query that counts problems** — rows violating an expectation — plus
a threshold above which it fails. Without `sql` the check runs nothing and scores nothing,
which is why it is required.

`severity` is the consequence, not the size: `error` for something that invalidates
analysis (a null primary key, a date before birth), `warning` for something worth knowing
(an implausible outlier), `info` for a count you want tracked.

Write checks that name the problem in `name` — "Non-null person id" reads better in a
report than "check 1".

## Data catalogs

`dimensions` are the columns counted over. An empty list produces a catalog that computes
nothing — the validator warns, because it imports cleanly and then shows nothing.

## Concept-mapping projects

`mappings` aligns a local code to an OMOP concept. Two fields carry the weight:

- **`sourceConceptCode`** is the row's identity — the local code as it appears in the
  source database. Required.
- **`targetConceptId`** is the OMOP concept it maps to. Required **when `status` is
  `approved`**: an approved row with no target maps nothing at all, and nothing in the
  app says so.

`status` defaults to `pending`, deliberately — an unreviewed alignment is not an approved
one, and defaulting the other way would manufacture that failure for every row.

Rows are sorted by `sourceConceptCode` on write, so re-exporting the same alignments is
byte-stable and the git diff shows only real changes.

**A mapping is a clinical judgement**, not a lookup. Only mark `approved` what you have
actually verified — the same code can map to different concepts depending on how the
source system uses it, and a wrong alignment propagates silently into every analysis
built on it.

## Schema presets

A preset says how to read one database: which table holds patients, which holds visits,
and where each kind of clinical event lives. Get it wrong and every page built on that
database reads the wrong column — silently, since a plausible column name still returns
rows.

Three fields make an event table queryable at all, so all three are required: `table`,
`conceptIdColumn` (what the row is about) and `dateColumn` (when it happened). The rest
differ by event — a measurement has a value and a unit, a condition has neither.

The **DDL goes to `schema.ddl`**, never inline in `mapping.ddl`: it is a large text blob,
and on one JSON line it makes every diff unreadable. Pass it as `ddl` and the writer
places it; a preset that still carries it inline gets a legacy warning.

Mapping keys and event tables are written in a canonical order, so a preset you author
and the same preset exported from the app are the same bytes. Do not reorder them by
hand to "tidy" the file — that is the churn the ordering exists to prevent.

Anything beyond the event tables (`patientTable`, `visitTable`, `conceptTables`,
`genderValues`, `erdGroups`…) goes in `mapping`, merged as supplied. The four presets in
`linkr-public-content/database-schemas/` are the reference to copy from.

## Cohorts are not standalone

A **cohort belongs to a project** (it carries a `projectUid` and lives in `cohorts/`),
so there is no cohort repo to write. It is validated inside a project tree but the MCP
does not author one, and that is deliberate: a cohort is a `criteriaTree` — nested
groups, operators, negations — compiled to SQL. A wrong tree does not fail; it returns
a different population, and nothing downstream says so.

Build cohorts in the app, where the criteria editor shows the attrition at each step.
If asked to write one, say this rather than hand-rolling the JSON.

Two things to know when **reading or fixing** an existing `cohorts/*.json`:

- `name` and `description` are **LocalizedString** (`{"en": …, "fr": …}`), like every
  other entity. A bare string still imports — the app backfills it into both languages
  on read — but new files should carry the object. The export filename (and the id
  derived from it) is the slug of the **English** name, so renaming in another language
  leaves the file where it is.
- The criteria live under `criteriaTree.children` — a recursive tree of
  `{"kind": "group", …, "children": []}` and `{"kind": "criterion", "type": …, "config": …}`
  nodes, each carrying `operator`, `exclude` and `enabled`. There is no `rules` array;
  a node with `enabled: false` is skipped when the SQL is generated.
