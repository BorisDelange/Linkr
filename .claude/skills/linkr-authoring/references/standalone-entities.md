# Standalone entities

Five kinds live in their **own** folder or repo rather than inside a project, and are
written with `write_entity(path, kind, spec)`. This is the shape the
`linkr-public-content` repos use — one repo per entity.

Field lists: `describe_entity_schema(kind)`. This page covers what those cannot say.

| Kind | What it is | Files it produces |
|---|---|---|
| `sql-collection` | reusable SQL queries | `_collection.json` + `_tree.json` + `.sql` |
| `etl-pipeline` | ordered SQL that builds a target database | `_pipeline.json` + `_tree.json` + `.sql` |
| `dq-rule-set` | data-quality checks run against a database | `rule-set.json` + `checks.json` |
| `data-catalog` | counts over chosen dimensions | `catalog.json` |
| `mapping-project` | local codes aligned to OMOP concepts | `project.json` + `mappings.json` |

## SQL collections and ETL pipelines

Same shape; the difference is intent. A collection is a drawer of queries someone opens
one at a time; a pipeline is an **ordered** sequence that builds something, so the `order`
field and the file naming carry meaning — number them (`01_person.sql`, `02_visit.sql`).

Folders are declared in `_tree.json` automatically. Do not write that file yourself: a
file whose parent folder is missing gets reparented to the root on import, silently
flattening the layout.

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

## Not writable yet

**Cohorts** (inside a project) and **schema presets** are validated but not written.
Say so rather than hand-rolling their JSON — the next validation would disagree with you.
