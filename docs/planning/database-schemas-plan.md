# Database schemas — reading a source that has more than one

A clinical warehouse rarely lives in one namespace. MIMIC-IV is published as
`hosp`, `icu` and (separately) `note`; eHOP spreads 56 tables over 11 Oracle
schemas. Linkr flattens all of it: a mapping addresses a table by a bare name,
and a Parquet import drops the folder the file came from.

Flattening is lossy in a way that is not merely cosmetic. In eHOP 4.4 the
de-identified `EDBM_EDS.EHOP_PATIENT` and the nominative
`EDBM_ZPAT.EHOP_PATIENT` are two different tables with one name; once flattened,
one of them is simply unreachable — which is why the published `ehop-4.4` preset
ships the nominative one commented out in `schema.ddl`.

DuckDB has schemas and handles this fine. The limitation is entirely ours.

## What was measured, not assumed

Everything below was run against a real full MIMIC-IV Parquet folder (36 files,
364 627 patients / 94 458 ICU stays / 331 793 notes), in Python (duckdb 1.4.4)
and R (duckdb 1.5.4.3) — identical results, so this is engine behaviour, not a
driver quirk.

| Form | Resolves? |
|---|---|
| `"EDBM_EDS.EHOP_PATIENT"` — one quoted identifier, **what Linkr emits today** | ❌ names a table containing a dot |
| `"EDBM_EDS"."EHOP_PATIENT"` — two quoted identifiers | ✅ |
| `patients` — bare, with the schema on `search_path` | ✅ |
| `source.patients` — catalog.table, with the schema on `search_path` | ✅ |
| `source.hosp.patients` — catalog.schema.table | ✅ exact, no search |
| `source.icu.patients` — wrong schema | ❌ hard error, no fallback |
| bare name with **homonyms** on the path | ⚠️ first on the path wins, **silently** |

Four consequences drive the design:

1. **`search_path` is the compatibility layer.** With the source's schemas on it,
   both the bare names in today's mappings *and* the `source.<table>` in today's
   ETL pipelines keep resolving, untouched.
2. **Three-part names are exact.** No fallback, so a wrong schema fails loudly
   rather than reading the wrong module. Good property; it means presets must
   name the right module.
3. **Names are case-insensitive**, quoted or not: `source.edbm_eds.ehop_patient`
   reaches `EDBM_EDS.EHOP_PATIENT`.
4. **Only qualification disambiguates homonyms.** For eHOP this is a correctness
   fix, not a nicety.

## The shape of the change

**`search_path` first, qualification second.** Every existing preset, pipeline and
saved query keeps working because the schemas are on the path; a mapping or a
script that *wants* to be precise qualifies. Nothing has to migrate on the day the
feature lands, and migration is per-script — a three-part name and a two-part name
work in the same query (verified).

Three independent, individually shippable steps, in dependency order.

### 1. `search_path` on attach — the safety net (no visible change)

The backend already does this for Parquet folders (`query_parquet_folder`,
`db_connect.py:638`) and for external/file sources (`:391`, `:429`). Extend it to
`_attach_role`, and build the path from the schemas actually present rather than a
hardcoded `main`.

Ship this **before** anything can create a multi-schema source, so no ordering
accident can break an existing pipeline.

- `_attach_role` / `_attach_alias_role`: after attaching, read the schemas from
  `information_schema.schemata` and `SET search_path` to all of them.
- Order matters where homonyms exist. Deterministic and documented: declaration
  order from the preset, else alphabetical.

### 2. Schema-aware import — keep the folder

`_table_of` (`db_connect.py:570`) and its frontend twin `extractTableName`
(`engine.ts:633`) already receive the full relative path and already handle
sharded layouts (`icu/chartevents/part-00000.parquet` → `chartevents` ✅) — they
just throw the leading segment away.

Both must return `(schema, table)` instead of `table`, and both must change in the
same commit: they are the same algorithm twice, and `table-naming.test.ts` pins
the frontend one.

- A path segment above the file (and above a shard directory) becomes the schema.
- No such segment → no schema → the default one. **A flat folder keeps working
  exactly as today**, which is what protects folders already imported flat.
- `_group_parquet` keys on `(schema, table)`; the view creation already knows how
  to make non-`main` schemas (`db_connect.py:1058-1062`).
- `data_source_files.file_name` already stores the relative path — no migration.
- The mapping's `knownTables` is what lets `hosp/patients.parquet` be recognised,
  so it stops being cosmetic (see the MIMIC-IV bug in step 4).

### 3. `schema?` in the mapping — the precise style

```ts
patientTable?: { schema?: string; table: string; ... }
```

on every table-bearing block (`patientTable`, `visitTable`, `visitDetailTable`,
`noteTable`, `deathTable`, `conceptTables[]`, `eventTables{}`) plus the lookup
tables (`careSiteNameTable`, `unitNameTable`).

The work is a single helper — `qualify({schema, table})` → `"hosp"."patients"`,
**two quoted identifiers, never one** — and then routing every interpolation
through it: ~91 `FROM "${...}"` across 10 files
(`patient-data-queries.ts`, `cohort-query.ts`, `concept-queries.ts`,
`data-quality.ts`, `database-stats.ts`, `catalog-queries.ts`,
`patient-overview-queries.ts`, `engine.ts`, `concept-profile.ts`,
`source-extraction.ts`). Mechanical, but it must be done in one pass — a missed
site is a query that silently reads the wrong schema.

Absent `schema` ⇒ bare name ⇒ resolved by step 1. Existing presets need no edit.

Also: the preset editor (`SchemaPresetsPage.tsx`) needs a schema field per table,
and `packages/linkr-format` must carry `schema` through
(`schema-mapping.ts` field order, `serialize/entities.ts`) — CLAUDE.md's
"export format has a second home" rule.

### 3a. Mount a WASM folder as a catalog, not a schema — decided

`role-prefix.ts` rewrites a role qualifier into the source's schema: `source.` →
`"<schema>".`. Fine for the two-part form, but `source.hosp.patients` would become
`"<schema>".hosp.patients` — a schema where a catalog is expected — because a WASM
folder source is mounted as a *schema* `ds_<id>` inside the single `memory`
database, which uses up the only level available.

DuckDB is not the constraint: three levels work in WASM as anywhere else, and the
client **already** ATTACHes a database per source for the single-file case
(`engine.ts:208`). Only the folder path uses `CREATE SCHEMA`.

So: mount a folder with `ATTACH ':memory:' AS ds_<id>` too, and put the module
schemas inside it. Both modes then agree — a source is a catalog, its modules are
schemas — and `role-prefix.ts` needs no change at all: `source.hosp.patients`
becomes `"ds_abc".hosp.patients`, which is valid. Verified against the same mount
shape: three-part names, the bare name via `search_path`, and `ds_abc.patients`
all resolve, and two modules may hold the same table name.

Rejected: folding the two levels into `"<schema>_hosp".`. It invents schema names
that exist nowhere in the source and makes the client diverge from the server.

Watch two things: the places that assume "schema-based **or** ATTACHed"
(`discoverTables`, `safeDropSchema`, the `attached` flag, the four `search_path`
sites), and `mountEmptyFromDDL`, which has the same one-level assumption *and*
swallows failed statements in a `console.warn` — so a regression there would be
silent. Fixing it is also the prerequisite for step 5's schema-qualified DDL.

### 4. Content — MIMIC-IV first

Do this *after* 1–3, as the end-to-end test.

**A real bug to fix in the published preset**, found while measuring: `radiology`,
`radiology_detail` and `discharge_detail` are in `schema.ddl` and in the ERD but
missing from `knownTables`; `demo_subject_id` is in `knownTables` but in neither.
Harmless today (the file-stem fallback catches it — verified, 35 files → 35
tables), **blocking** under step 2, where `knownTables` is what recognises
`hosp/patients.parquet`.

Then: re-lay the Parquet as `hosp/`, `icu/`, `note/` mirroring the PhysioNet
download; add `schema` to the mapping; regenerate the DDL with `CREATE SCHEMA`.

Note `note` is a **separate PhysioNet download** (MIMIC-IV-Note) — `discharge`,
`discharge_detail`, `radiology`, `radiology_detail`. It is a third schema, and the
two ETL pipelines read `source.discharge` / `source.radiology`, so it must be on
the `search_path` or they break.

eHOP comes after, and gets back the table 4.4 had to comment out.

## ETL pipelines — the fragile part

`mimic-iv-demo-to-omop` (public) and `mimic-iv-to-omop` (private) address the
source as **`source.<table>`** — 24 distinct tables each, across 32 SQL scripts.
That is `catalog.table`, relying on everything sitting in one `main` schema.

Measured: with schemas and **no** `search_path`, `source.patients` fails —
**both pipelines break**. With the schemas on the path it resolves, unchanged.
Step 1 is therefore not optional, and must land first.

Migration to `source.hosp.patients` is then per-script and optional; both styles
join in one query (verified). If a homonym ever appears between two schemas of one
source, compatibility views in `source.main` are the fallback (verified) — not
needed for MIMIC-IV, which has none.

## Risks

- **Silent homonym resolution.** A bare name with two candidates takes the first
  on the path, with no warning. Mitigation: the preset editor should flag a table
  name existing in several schemas of the source, and eHOP presets should qualify.
- **A missed interpolation in step 3** reads the wrong schema silently. Mitigation:
  one helper, no direct `FROM "${...}"` left; grep is the review.
- **Re-import required** to gain schemas. A flat folder stays readable, so this is
  opt-in, never forced.

## Steps

| St | Item | Effort |
|----|------|--------|
| 🔜 | 1. `search_path` from the attached schemas in `_attach_role` (+ deterministic order) | S |
| 🔜 | 2. `_table_of` + `extractTableName` return `(schema, table)`; `_group_parquet` keys on the pair; views per schema; update `table-naming.test.ts` | M |
| 🔜 | 3. `schema?` on the mapping + `qualify()` + the ~91 call sites + preset editor + `linkr-format` | M/L |
| 🔜 | 4. Fix MIMIC-IV `knownTables` (add `radiology`, `radiology_detail`, `discharge_detail`; drop `demo_subject_id`) | S |
| 🔜 | 5. **[TO TEST]** Re-lay MIMIC-IV Parquet as `hosp/` `icu/` `note/`, DDL with `CREATE SCHEMA`, re-import, check Patient Data + both ETL pipelines | M |
| 🔜 | 6. Rebuild the eHOP presets with their 11 schemas; restore the nominative `EHOP_PATIENT` in 4.4 | M |
