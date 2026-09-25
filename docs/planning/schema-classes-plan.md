# Schema mapping v2 — classes with an output contract, built visually or in SQL

A schema mapping tells Linkr where each clinical notion lives in a source: patients,
stays, units, notes, concepts, events. Today it does that **column by column, in
fixed blocks**: `visitTable` names one table, then one field per column, plus
ad-hoc triples for lookups (`careSiteNameTable` / `careSiteNameIdColumn` /
`careSiteNameColumn`).

That covers a source that is already in OMOP or close to it (MIMIC, OMOP 5.x). It
fails as soon as one row of a class is spread over several rows or tables. The
typical case is an **entity-attribute-value (EAV) warehouse**: one drug
administration is several rows (the product, the route, the rate, the
concentration, the duration), each tagged by an attribute code, which have to be
pivoted back by self-joins on a document key. No column-by-column form can express
that, so such a source ends up mapped as one generic "structured data" event
table, and the drug semantics are lost.

This plan proposes one change of model, from which both requested improvements
follow:

> **Each class has an output contract (a fixed list of columns). The mapping
> produces, for each class, a SQL relation that honours that contract. The
> relation is either generated from the visual form or written/edited in SQL
> (the Cohort "Modified" pattern). Every consumer queries the contract, never the
> mapping.**

---

## 1. What is wrong today (measured in the code)

- **Fixed blocks, one table per class.** `SchemaMapping`
  (`types/schema-mapping.ts:29-319`) has `patientTable`, `visitTable`,
  `visitDetailTable`, `noteTable`, `deathTable`, `conceptTables[]` and
  `eventTables{}`. Each block names **one** table (+ `schema?`), and every field
  is a column of that table. The only escape hatches are one-off lookup triples
  (care site, unit name) and special cases (`anchorAge/anchorYear` for MIMIC-IV,
  `deathTable` vs `patientTable.deathDateColumn` precedence,
  `conceptDictionaryKey: 'none'`, the composite `conceptVocabularyColumn +
  conceptCodeColumn` join).
- **Every consumer re-derives SQL from the mapping itself.** About 80 files read
  `schemaMapping`: patient data (`patient-data-queries.ts`,
  `patient-overview-queries.ts`), concepts (`concept-queries.ts`), cohorts
  (`cohort-query.ts`, `cohort-report/queries.ts`), DQ, database stats, catalog,
  concept mapping, the MCP tools, and server-side cohort derivation. Each one
  re-implements the lookup joins, the age computation and the death precedence.
- **The consumers have already drifted.** The schema-qualification effort left
  bare `"${table}"` sites that ignore `schema`: `cohort-query.ts:685,734,751`,
  `catalog-queries.ts:189,526`, `data-quality.ts:71,117,133`,
  `database-stats.ts:153`, `source-extraction.ts:102,190`,
  `CatalogDcatTab.tsx:158`. The visit-level care-site join exists only in the
  cohort builder, and `catalog-queries.ts` uses `typeColumn` for the same notion.
- **The editor has gaps.** `EditableVisitTable` (`SchemaPresetsPage.tsx:585`)
  cannot edit `careSiteColumn` / `careSiteName*`. They show read-only, and their
  labels come from `formatColumnKey` title-casing camelCase keys ("Care Site Name
  Table", "Care Site Name Id"…). That is the screen in the request.
- **Drugs are guessed.** Drugs are an event table like any other, recognised by
  `looksLikeDrugName` (`overview-layout.ts:410`). No dose, rate or route semantics
  can be relied on.

## 2. What OHDSI does (WhiteRabbit, Rabbit-in-a-Hat, Perseus)

Clones read for this plan: `OHDSI/WhiteRabbit` (commit of Oct 2025) and
`OHDSI/Perseus` (last commit Nov 2023, dormant).

- **Rabbit-in-a-Hat** (`rabbit-core/.../dataModel/`) has two levels. Table
  arrows come first (`ETL.tableToTableMaps`), then field arrows, which exist
  **only inside a (source table, target table) pair**
  (`tableMapToFieldToFieldMaps`). Every arrow (`ItemToItemMap`) carries only a
  free-text `logic`, a `comment` and `isCompleted`.
  - **No joins, no expressions, no constants.** Many sources into one target are
    separate parallel arrows, i.e. a UNION.
  - **Complex cases live in prose.** Anything complex (joins, filters, lookups,
    dedup) goes into free text.
  - **Its "SQL skeleton"** (`SQLGenerator.java`) is `INSERT INTO t (...) SELECT
    src.col AS tgt … FROM src;`, with the logic pasted as comments: one table, no
    JOIN, no WHERE. It is a starting point for hand-editing, and **the spec and the
    real ETL drift apart by construction**. OHDSI patches that with a generated R
    test framework (`add_<src>()` / `expect_<cdm>()`).
- **WhiteRabbit** profiles the source into an xlsx: types inferred from values,
  value frequencies, fraction empty, unique counts, numeric stats. The profile
  counts are cut under `minCellCount`. That file **is** RiaH's source schema. The
  profile travels with the model and feeds the mapping (most frequent values,
  concept hints).
- **Perseus** adds the structured extras RiaH lacks. Each field arrow can carry:
  - a **SQL transform**, in `visual` (a chain of preset functions) or `manual`
    (free SQL expression) mode;
  - a **constant**;
  - a **concept lookup** (Maps-to CTE templates).

  Two more features apply at table level:
  - **Conditioned target clones**: one source table feeds the same target N
    times, each clone guarded by a SQL condition.
  - **Joins through "views"**: the user writes SQL, which becomes a virtual source
    table the arrows then map from.

  It generates CDMBuilder XML that a heavyweight .NET engine executes.

**What we take from them:**

1. **Grain first.** Their model anchors a field to a table link, and that is what
   avoids an ambiguous join. The same idea drives the answer to question 1 below.
2. **Visual and manual per unit, with SQL as the escape hatch.** Perseus's
   `visual | manual` is the Cohort pattern. Its "view" (SQL that becomes the
   source) is exactly the "custom SQL per class" asked for here.
3. **Filters and clones.** One EAV table must feed several classes (labs,
   vitals, drugs), each with a WHERE.
4. **What not to copy:** prose as the only record of logic (RiaH), and an
   external execution engine (Perseus). In Linkr the relation **is** the
   executable spec. It runs in DuckDB at read time, in both modes.
5. **Later:** the source profile in the field picker (value frequencies à la
   WhiteRabbit). Linkr already profiles in the ETL builder.

## 3. Question 1: `table.column` per field?

**Yes to qualified references, no to a free table per field.** If `start_datetime`
could come from `A.x` and `end_datetime` from `B.y` with nothing else declared,
the generator has to guess **how A and B join**, and **which one sets the grain**
(one row per stay? per movement?). RiaH and Perseus both refuse that ambiguity for
the same reason.

The v2 form of a visual relation is therefore:

- **`from`**: the grain table, one row of the class per row of that table. It is
  fully qualified (`schema` + `table`) and has an alias.
- **`joins[]`**: named joins, each with a type (`left` | `inner`), a table, an
  alias and an `on` clause given as column pairs. This replaces every lookup
  triple (care site, unit name, the death table, the gender table…) with **one
  general mechanism**.
- **`where`** (optional): a filter expression. It lets one EAV table feed several
  relations (Perseus's clone + condition).
- **`fields`**: target column → one of
  - `"alias.column"`: a column reference, validated as identifiers and quoted by
    the generator;
  - `{ "expr": "…" }`: a free SQL expression (Perseus manual transform), e.g. a
    birth year from `anchor_year - anchor_age`, or a `CASE` on genders;
  - `{ "value": … }`: a constant.

Your example becomes:

```json
"visit": {
  "from":  { "schema": "public", "table": "visit_occurrence", "alias": "v" },
  "joins": [{ "type": "left", "table": "care_site", "alias": "cs",
              "on": [["v.care_site_id", "cs.care_site_id"]] }],
  "fields": {
    "visit_id":       "v.visit_occurrence_id",
    "patient_id":     "v.person_id",
    "start_datetime": "v.visit_start_datetime",
    "end_datetime":   "v.visit_end_datetime",
    "visit_type":     "v.visit_source_value",
    "care_site_id":   "v.care_site_id",
    "care_site_name": "cs.care_site_name"
  },
  "customSql": null
}
```

In the editor, a field is a combobox listing `alias.column` for every table in
`from` + `joins`. Columns come from the DDL the preset already carries (the ERD
parses it), or from `DESCRIBE` on a bound database. An "ƒx" toggle switches the
field to an expression. The table is no longer a field among the others.

## 4. Question 2: custom SQL?

**Yes, per class relation, with the Cohort / patient-widget contract**
(`Cohort.customSql`, `PatientWidget.customSql`):

- **Effective SQL** = `customSql ?? generate(visual)`.
- **Code icon.** It opens a modal with the SQL. Editing and saving (Cmd+S) stores
  `customSql`. The relation gets the amber *Modified* dot (`CustomSqlDot`).
  **Reset** returns to generated SQL. Saving text identical to the generated SQL
  stores `null`.
- **Changing the visual form while `customSql` is set** opens the overwrite
  dialog (`CohortBuilderPage.tsx:149-170`). As in `PatientWidgetEditorSheet`, the
  dialog only opens if the **generated SQL actually changes**, so a cosmetic edit
  never prompts.
- **Pure SQL relation**: `customSql` with an empty visual form. The form then
  shows "Defined in SQL" and the contract only.

Custom SQL is not a free-for-all: it has to **honour the class contract** (§5).
That is what keeps it safe. Every consumer (cohorts, patient data, concepts, DQ,
stats, MCP) keeps working, whatever the SQL does inside.

## 5. Class contracts

Each relation is exposed to queries under a reserved name, `linkr_<class>` (and
`linkr_<class>_<slug>` for the multi-instance classes). The `linkr_` prefix keeps
them from shadowing a source table: MIMIC has a `patients` table. It also says
where the name comes from when it shows up in a SQL tab. Contract columns are
snake_case. Columns marked `*` are required; the others are optional. A feature
that needs a missing column says so ("map `visit.end_datetime` to see lengths of
stay"), generalising `missing` in `widget-sql.ts`.

| Class | Relation | Grain | Columns |
|---|---|---|---|
| patient | `linkr_patient` | 1 row / patient | `patient_id*`, `birth_date`, `birth_year`, `gender` (normalised `male`/`female`/`unknown`), `gender_source_value`, `death_datetime` |
| visit | `linkr_visit` | 1 row / stay | `visit_id*`, `patient_id*`, `start_datetime*`, `end_datetime`, `visit_type`, `care_site_id`, `care_site_name` |
| visit_detail | `linkr_visit_detail` | 1 row / movement | `visit_detail_id*`, `visit_id*`, `patient_id*`, `start_datetime*`, `end_datetime`, `unit_id`, `unit_name` |
| note | `linkr_note` | 1 row / document | `note_id*`, `patient_id*`, `visit_id`, `note_datetime*`, `title`, `text*`, `note_type` |
| concept (n) | `linkr_concept_<key>` | 1 row / concept | `concept_id*`, `concept_terminology`, `concept_name*`, `concept_code`, `terminology_id`, `terminology_name`, `category`, `subcategory`, + declared `extra_*` (e.g. `standard_concept`) |
| event (n) | `linkr_event_<slug>` | 1 row / observation | `patient_id*`, `concept_id*`, `start_datetime*`, `visit_id`, `visit_detail_id`, `concept_terminology`, `source_concept_id`, `concept_name`, `end_datetime`, `value_number`, `value_string`, `unit`, `unit_concept_id` |
| drug (n) | `linkr_drug_<slug>` | 1 row / administration or prescription line | `patient_id*`, `concept_id*`, `start_datetime*`, `drug_id`, `visit_id`, `visit_detail_id`, `concept_terminology`, `source_concept_id`, `concept_name`, `end_datetime`, `quantity`, `amount_value`, `amount_unit`, `rate_value`, `rate_unit`, `concentration_value`, `concentration_unit`, `duration_value`, `duration_unit`, `is_continuous`, `route`, `route_concept_id`, `dose_source_value` |

What each contract absorbs:

- **patient**: `deathTable` becomes a join plus `death_datetime`, so the
  precedence rule disappears. `genderValues` becomes a generated `CASE`, so no
  consumer compares raw gender codes any more. `anchor_*` becomes a `birth_year`
  expression.
- **concept identity is unchanged.** `concept_id` is whatever the dictionary
  exposes today. `concept_terminology` carries the terminology half of a
  composite key (terminology + code), and the concept join uses both when present. Saved
  cohorts and concept lists keep their ids.
- **`concept_name` on event/drug** replaces `conceptDictionaryKey: 'none'`. A
  relation that names its concepts inline (MIMIC `prescriptions.drug`) simply
  outputs it.
- **drug is a class of its own.** It replaces `looksLikeDrugName` and gives the
  patient-data drug widgets real dose, rate and route semantics. **The exact
  column list is to be settled with those widgets** (step 7), not guessed here.

Ids have no fixed type: they may be VARCHAR or BIGINT. Consumers already compare
them with quoted literals, which DuckDB casts.

## 6. How relations reach queries

**Injection as non-materialised CTEs.** One pure helper,
`withClassRelations(sql, mapping)`, prepends
`WITH linkr_visit AS NOT MATERIALIZED (…), …` for the `linkr_*` names the query
actually references. It is stateless, and identical in client (WASM) and server
mode. The "SQL" tabs that show a query (widget SQL, cohort SQL) show the
relations too, which makes the query readable and copy-pastable. Because
injection is triggered by reference, **user SQL anywhere** (cohort `customSql`,
widget SQL, SQL collections on a mapped database) can use `linkr_visit` as well.
The classes become a public vocabulary.

Measured on DuckDB 1.5.5 (Python, 20 M-row event table, `WHERE patient_id = 42`):

| Relation shape | Time | Note |
|---|---|---|
| direct query on the table | 35 ms | baseline |
| CTE, simple projection, referenced once | 5 ms | filter pushed down |
| CTE referenced **twice**, default | 14 ms | DuckDB 1.5 **materialises it** (`CTE_SCAN`) |
| same, `AS NOT MATERIALIZED` | 8 ms | inlined again → always emit `NOT MATERIALIZED` |
| self-join pivot (EAV-like) | 7 ms | pushed down |
| `ROW_NUMBER() OVER (PARTITION BY pid …)` | 9 ms | pushed down |
| `ROW_NUMBER() OVER (ORDER BY id)` (global) | **503 ms** | **blocks pushdown**: ×100 |

Consequences:

- A **generated** relation is a projection plus joins, and costs nothing over
  today. Phase A has no performance risk.
- **An EAV pivot is fine**: self-joins on the EAV table, keyed on a source row
  id, push the patient filter down.
- **A global window blocks it.** The SQL editor warns on a global window (no
  `PARTITION BY`): "blocks per-patient filtering; use a source key as the id, or
  materialise". This is why `drug_id` is optional.
- **Materialisation** (step 12) is opt-in per relation, for SQL that stays heavy:
  - **Server**: a Parquet cache keyed by (effective SQL hash, source
    fingerprint), built as a job, like the concept-count cache.
  - **Client**: an in-session table.
  - **Caveat**: the server's read-query connections are cut off from the
    filesystem (AI plan, security item), so the cache is attached as a catalog,
    not read through `read_parquet(path)`.

**What this centralises.** Qualification (`qualify`), lookup joins, age, death
precedence, gender normalisation, the composite concept join: today each consumer
redoes them, and some already diverge (§1). With this plan they are written
**once**, in the generator of each relation. A consumer only knows
`linkr_visit.start_datetime`. The ten unqualified sites disappear with the code
that produced them.

**Name resolution in class SQL: the database's own tables only.** A class SQL
references the tables of the database it describes, exactly like today's
mappings: a bare name via `search_path`, or `schema.table` for a source with
several schemas (see database-schemas-plan). **No roles.** `source.` / `target.`
/ `vocab.` belong to ETL pipelines, which move data **between** databases. A
schema mapping describes **one** database, so it has nothing to address outside
it. An OMOP database already holds `concept` and `concept_relationship`, and its
dictionary relation reads them in place.

**Safety.** The class SQL of an imported preset is untrusted, just like the
`customSql` of an imported cohort. It is:

- checked to be a **single SELECT/WITH statement**, using the shared
  `sql-tokenizer` (no `;` outside protected regions);
- executed only through the **read-only query path**, like cohort SQL;
- shown to the user as SQL before installing a preset that carries it.

`sanitizeSchemaMapping` keeps validating the visual identifiers. Expressions
(`expr`) fall under the same rules as class SQL.

**Contract check.** `DESCRIBE (<effective SQL>)` on a database gives the columns
the relation actually returns. The modal reports missing required columns,
unknown columns (ignored, with a warning) and types that do not fit (e.g. a
`start_datetime` that is VARCHAR). A **Preview** tab runs `LIMIT 100`. The same
check is a DQ rule ("relation honours its contract"), together with id
uniqueness per grain.

## 7. Per-database override — the site layer

Sites running the same product differ subtly: in an EAV warehouse, the attribute
codes of drug rows can change from one hospital to another. The preset carries
the shared mapping, and each database can override it.

**Two levels of override, the light one first:**

1. **Parameters.** A relation declares named parameters with a default. The
   preset's drug relation declares `attr_route = '<code>'`, `attr_rate =
   '<code>'`, and so on. The SQL (or a visual `where`/`expr`) references them
   as `{{attr_route}}`. A database only changes the **values**.
   - **Safety**: parameters are substituted as **escaped string literals only**
     (`escSql`), never as identifiers or SQL fragments, so a parameter value
     cannot inject SQL.
   - **Survives updates**: a parameter override keeps working when the preset is
     updated, since the SQL around it is still the preset's. This covers the EAV
     case entirely: each attribute code is a parameter.
2. **Relation override.** A database replaces a whole relation, visual or SQL,
   for a real structural difference (a table that does not exist at one site, a
   different join). The relation gets an "Overridden" badge and a "Revert to
   preset" action.

**Data model.** The database keeps what it has today, `schemaSource` (lineage,
label, version) plus `schemaMapping`, a **copy** of the preset that stays the
**base**, so a database works even if the preset is deleted. It gains
`schemaOverrides: { params: {name: value}, relations: {"drugs.administrations": {…}} }`.
One pure function, `effectiveMapping(ds) = base ⊕ overrides`, feeds the relation
generator. No consumer sees the difference.

**Updating from the preset becomes explicit.**

- **Today it is silent.** Saving the Edit dialog quietly re-copies the installed
  preset (`AddDatabaseDialog.resolveMapping`) and writes over the database's
  mapping.
- **"Update from preset" instead.** The action shows the version change and
  replaces the base. It keeps the overrides and **flags every relation override
  whose base relation changed** ("the preset changed this relation since you
  overrode it"), with the diff: old base, new base, your override.
- **Fix on the way**: `CreateFromPresetDialog` does not pass `schemaSource`
  today, so databases created from a preset DDL have no provenance.

**UI: a "Mapping" tab on the database page.** `DatabaseDetailPage` has overview,
statistics, schema, cohorts, readme, license and versioning.

- **Where it goes**: the "Schema" tab is the live table browser and stays. The
  new **Mapping** tab sits next to it and reuses the preset editor in *override*
  mode:
  - a parameters panel at the top;
  - each relation shows "From preset" or "Overridden".
- **Read-only in a project**, like the rest of the page.
- **The natural place to write SQL.** A database is bound, so Preview and the
  contract check work there. A preset has no data; its editor can offer "Preview
  on…" any database that uses it.
- **"Promote to preset"** pushes an override up into the preset when it turns out
  to be general, for a user with rights on the preset.
- **Export**: the database tree already writes `mapping.json` (the base). It adds
  `mapping-overrides.json`, which is a linkr-format change like §8.

## 8. Mapping format v2

```json
{
  "formatVersion": 2,
  "patient":      { "from": …, "joins": [], "fields": {…}, "customSql": null },
  "visit":        { … },
  "visitDetail":  { … },
  "note":         { … },
  "concepts":     [{ "key": "concept", "from": …, "fields": {…}, "customSql": null }],
  "events":       [{ "slug": "labs", "label": {"en": "Lab results", "fr": "Biologie"},
                     "conceptDictionaryKey": "concept", "from": …, "where": "…", "fields": {…}, "customSql": null }],
  "drugs":        [{ "slug": "administrations", "label": {…}, "conceptDictionaryKey": "concept",
                     "params": { "attr_route": { "default": "<code>", "label": {…} }, … },
                     "customSql": "WITH rows AS (SELECT … FROM <eav_table> …) SELECT … WHERE route.attr = {{attr_route}} …" }],
  "knownTables": […], "ddl": "…", "erdGroups": […], "erdLayout": {…}
}
```

- **v1 → v2 conversion** is one pure function (`mappingV1ToV2`), tested on every
  published preset (OMOP 5.3/5.4, MIMIC-III/IV) and on the private presets. It runs at the
  trust boundary (`sanitizeSchemaMapping`, i.e. the store, import, pull). Linkr
  **writes v2 only**. There is no dual support, in line with your preference for
  cleaning the base over compat layers: a v1 read is converted once, and nothing
  else knows v1 existed.
- **Export format has a second home**: `packages/linkr-format/src/schema-mapping.ts`
  (canonical order, `MAPPING_FIELD_ORDER`), the reader/validator/serializer,
  the Python twin `_canonical_schema_mapping`
  (`workspace_export_assemble.py:1060`), `entity-io.ts`, and the schema-preset
  golden fixture all change **in the same step**. The shape of an exported entity
  changes, so **a `VERSION` bump is warranted at release time — not done by this
  plan**, to be asked when the release comes.
- **Server-side cohort derivation** (`services/data/cohort_derive.py`) classifies
  raw tables by the **id column names** read from the mapping (`id_columns`).
  With a visual relation they stay readable (`from` + `fields.patient_id`). With
  a pure SQL relation they are not, so v2 adds an optional
  `derive.patientKeyColumns` / `visitKeyColumns` (the raw column names). Otherwise
  derivation refuses with a clear reason (`derivableReason`).

## 9. Generating an OMOP ETL from a source schema

**What an ETL pipeline is today** (`features/warehouse/EtlPipelinePage.tsx`):

- **Databases**: a source database and a target database. The target is created
  beforehand from an OMOP preset's DDL.
- **Vocabulary**: an optional mapping project, whose Vocabulary tab generates
  `00_vocabulary.sql` / `99_prune_vocabulary.sql` (C/CR or STCM, source concepts
  from 2 billion).
- **Scripts**: an ordered tree of SQL/R/Python scripts **written by hand**,
  addressing `source.` / `target.` / `vocab.`, resolved at run time. No generator
  exists besides the vocabulary one.

**Once the source has class relations, most of an OMOP ETL can be generated.**
The contract is a **pivot model** between the two databases:

- **Source side**: the source mapping says how to read each class,
  `linkr_visit(visit_id, patient_id, start_datetime, …)`.
- **Target side**: the OMOP preset mapping, in visual mode, says where each
  contract column lives in OMOP (`visit_id ← v.visit_occurrence_id`, …). Visual
  fields are column references, so they are **invertible**:
  `visit_occurrence.visit_occurrence_id ← visit_id`.
- **Composition**: one INSERT per class, with a pure generator in `lib/`:

```sql
-- 20_visit_occurrence.sql — generated from source schema "<name>", do not edit
-- without expecting a "Modified" mark
INSERT INTO target.visit_occurrence (visit_occurrence_id, person_id, visit_concept_id,
  visit_start_date, visit_start_datetime, visit_end_date, visit_end_datetime,
  visit_type_concept_id, care_site_id, visit_source_value)
WITH linkr_visit AS (<effective source relation>)
SELECT visit_id, patient_id, 0,                       -- TODO(etl): visit_concept_id
       CAST(start_datetime AS DATE), start_datetime,
       CAST(end_datetime AS DATE), end_datetime,
       32817,                                         -- EHR
       care_site_id, visit_type
FROM linkr_visit;
```

**What the generator fills in beyond the contract.** OMOP rules live in one
place:

- `*_date` companions from `*_datetime`;
- `*_type_concept_id` as a constant (32817 EHR, overridable in the dialog);
- `*_concept_id` through the vocabulary the pipeline already generates: `LEFT
  JOIN` on the 2-billion source concepts + 'Maps to' in C/CR mode, or on STCM;
- `*_source_value` / `*_source_concept_id` from the contract.

**Event and drug relations** each go to a target table chosen in the generate
dialog. The default comes from the class (drug → `drug_exposure`) or the label.
Routing by concept domain (`concept.domain_id`) is a later step.

**Generated, then editable: the same Modified pattern again.** Generated scripts
are written through `upsertGeneratedScript`, like the vocabulary scripts. Each
remembers the hash of its last generated content. Regenerating overwrites a
script silently only if nobody touched it, and asks otherwise.

**Roles, where they belong.** The generator emits `target.` and `vocab.`. The
source relation is inlined as is. Its bare names resolve because the ETL run puts
the source's schemas on the `search_path` (`_attach_role`, database-schemas step 1).
A visual relation can be emitted with an explicit `source.` qualifier for
robustness. To verify: a custom SQL source relation with two-part names inside an
ETL run, in both modes.

**Versus Rabbit-in-a-Hat.** Its skeleton is one table, no JOIN and the logic in
comments. Here the joins and pivots are already encoded in the source relation,
so the generated script **runs**. The mapping stays the spec, and the ETL is
derived from it instead of drifting away.

**Where the adapter stops.** A class relation is a read-time adapter: nothing is
written, the source is untouched (Dataiku pattern). Unit conversions against
`drug_strength`, dedup and era building are ETL work. They go into the generated
scripts (edited), not into the relation. The generator gives the path from one
to the other.

## 10. Order — the contract before the format

The value is in consumers reading a contract. Custom SQL is useless until they
do. **Arbitrated: three phases, plus a fourth for ETL generation.**

- **Phase A (pure refactor, no visible change).** Generate the `linkr_*`
  relations from **today's v1 blocks**, and port the consumers one by one to the
  contract.
  - **Proof, per consumer:** identical results before/after on `mimic-iv-demo`
    and `mimic-iv-demo-omop`, plus Vitest on the generator.
  - **Free fixes:** the drifted sites (§1) are fixed without extra work.
- **Phase B (format + editors + SQL).** v2, conversion, visual editor, Code modal
  with Modified / Reset / overwrite, contract check + preview, parameters, the
  per-database override and its Mapping tab.
- **Phase C (drugs).** Drug class and its widgets. Drug administrations from an
  EAV source written as a `drugs[]` relation (contexts as parameters) is the
  acceptance test, as is its OMOP twin on `drug_exposure`.
- **Phase D (ETL generation).** Generate OMOP scripts from a source schema into an
  ETL pipeline.

## Steps

| St | Item | Effort |
|----|------|--------|
| ✅ | Arbitrated 2026-09-25: three phases; `linkr_*` names; class SQL reads its own database only (no roles); per-database override | — |
| 🤔 | Arbitrate the details: the 7 contracts (§5), CTE injection over temp views, v1 converted then forgotten, parameters as literals only | S (review) |
| 🔜 | 1. `lib/schema-classes/`: contracts (declarative: column, required, type family) + `generateClassSql(mappingV1)` + `withClassRelations()` (reference detection via `sql-tokenizer`, `NOT MATERIALIZED`) — Vitest | M |
| 🔜 | 2. Port consumers to `linkr_*`, parity-checked on the two demo DBs: patient data + overview → concepts → cohort builder + report → DQ + stats + catalog → concept-mapping extraction → MCP. The server's `cohort_derive.py` last | L |
| 🔜 | 3. Mapping v2 types + `mappingV1ToV2` (tested on the 9 published presets) + sanitize/trust boundary + linkr-format (schema, canonical order, validator) + Python twin + goldens | M/L |
| 🔜 | 4. Visual editor v2: `from` / `joins` / `where` / field combobox (`alias.column`, ƒx expression, constant) from DDL columns; replaces the per-block `Editable*Table` and fixes the care-site gap | L |
| 🔜 | 5. Code modal per relation: extract a generic `GeneratedSqlEditor` from `SqlPreviewPanel` (extend, don't fork — ui-patterns §6); `customSql` + `CustomSqlDot` + Reset + overwrite dialog only when the generated SQL changes | M |
| 🔜 | 6. Contract check (`DESCRIBE`) + Preview (`LIMIT 100`) + single-statement guard + global-window warning; DQ rule "honours contract / id unique per grain" | M |
| 🔜 | 7. Parameters (`params` + `{{name}}` as escaped literals) | S |
| 🔜 | 8. Per-database override: `schemaOverrides` + `effectiveMapping()` + **Mapping** tab (override mode, badges, revert, promote) + explicit "Update from preset" with flagged overrides + `mapping-overrides.json` in the database export; fix `CreateFromPresetDialog` provenance and the silent re-copy on Edit | L |
| 🔜 | 9. Drug class: settle its contract with the patient-data drug widgets, retire `looksLikeDrugName` | M |
| 🔜 | 10. **[Acceptance]** administrations from an EAV source as a `drugs[]` relation (pivot on attribute codes, codes as parameters, one site overriding them) + the OMOP twin on `drug_exposure` | M |
| 🔜 | 11. ETL generation: invert the target preset's visual mapping, compose with source relations, OMOP rules (dates, type concepts, vocabulary joins), per-relation target table, `upsertGeneratedScript` + last-generated hash | L |
| 💤 | 12. Opt-in materialisation (server Parquet cache attached as a catalog; client in-session table) | M/L |
| 💤 | 13. Domain routing in ETL generation; source profile (value frequencies) in the field picker | M |
| 🔜 | 14. User docs in `linkr-website` (schema presets, database Mapping tab, ETL generation) + `docs/architecture.md` | S/M |

## Open questions 🤔

1. **Multi-source singleton classes.** Visits coming from two tables: is a UNION
   in custom SQL enough, or should `visit` accept several `from` like events do?
   Recommendation: custom SQL. The events/drugs lists already cover the common
   case.
2. **Drug grain.** Administration, prescription, or both as two relations? Sources
   often keep them apart. Recommendation:
   two `drugs[]` entries, with `drug_kind` in the contract.
3. **A database without a preset.** Can a database carry a mapping of its own
   (overrides with no base), or must a preset exist first? Recommendation: a
   preset first. The override layer stays a diff, and "Promote to preset" has a
   target.
4. **Non-OMOP targets for ETL generation.** Inversion works for any target whose
   preset mapping is visual (MIMIC-shaped, a custom datamart). Should the first
   version stay OMOP-only (its rules for dates, type concepts and vocabulary are
   specific)? Recommendation: OMOP first, with a generic "contract columns only"
   mode for other targets.
