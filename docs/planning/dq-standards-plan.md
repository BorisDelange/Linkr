# Data quality standards — DQD as public rule sets, multi-rule-set runs, DQV

Status: 🔜 arbitrated (2026-09-30), ready to build. Nothing built.

## Why

Three outside references meet our DQ rule sets and data catalogs:

- **OHDSI DataQualityDashboard (DQD)** — the reference set of checks on an OMOP
  CDM. Linkr already runs checks the DQD way (Kahn taxonomy, `violated / total`,
  threshold, "violated rows" query) but only generates its own from a schema
  preset (`lib/dq-templates.ts`).
- **W3C DQV (Data Quality Vocabulary)** — the RDF vocabulary HealthDCAT-AP uses
  to attach quality to a `dcat:Dataset`. Linkr emits none of it today.
- **QUANTUM labelling tool** (EU project, EHDS data quality & utility label) — a
  declarative questionnaire whose output is DCAT + DQV Turtle. It measures
  nothing, and several of its metrics ask for a report URL.

Target:
- DQ rule sets become **thematic and composable**: schema, sex plausibility,
  units, lab values, vital signs, ICU… DQD supplies some of them, and we write the rest.
- A **run** executes several rule sets on one database.
- A run exports as **DQV**.
- A data catalog publishes the latest DQV of its database in HealthDCAT-AP.

## 1. DQD — how its checks are stored

Local copy: `../DataQualityDashboard` (R package, Apache 2.0; upstream last
release 2026-05, local copy 16 commits behind).

Checks are **generated**, not stored:

| Piece | Where | Content |
|---|---|---|
| Check types | `inst/csv/OMOP_CDMv5.4_Check_Descriptions.csv` | 27 rows: `checkLevel` (TABLE / FIELD / CONCEPT), `checkName`, description, `kahnContext`, `kahnCategory`, `kahnSubcategory`, `sqlFile`, `evaluationFilter`, `severity` (fatal / convention / characterization) |
| Parameters + thresholds | `…_Table_Level.csv` (79 rows), `…_Field_Level.csv` (548), `…_Concept_Level.csv` (527) | One row per table / field / concept; one column per check + its `…Threshold` (% of violating rows allowed) |
| SQL templates | `inst/sql/sql_server/*.sql` (29 files) | SqlRender templates (`@schema`, `@cdmTableName`…), SQL Server dialect translated at run time; violated rows between `/*violatedRowsBegin*/ … /*violatedRowsEnd*/` |

Examples of parameter rows:

| Level | Row | Checks it switches on |
|---|---|---|
| Table | `CONDITION_OCCURRENCE` | `measurePersonCompleteness`, threshold 95 % |
| Table | `OBSERVATION_PERIOD` | person completeness 0 %, `measureObservationPeriodOverlap` 0 % |
| Field | `PERSON.year_of_birth` | required; `plausibleValueLow` 1850, `plausibleValueHigh` `YEAR(GETDATE())+1`, threshold 1 % |
| Field | `MEASUREMENT.measurement_date` | ≥ 1950-01-01, ≤ tomorrow; after birth, before death (1 %); within visit dates (5 %) |
| Field | `DRUG_EXPOSURE.days_supply` | between 1 and 365 (1 %) |
| Field | `MEASUREMENT.unit_concept_id` | FK to `CONCEPT`, domain `Unit`, standard & valid concept, standard-concept completeness 5 % |
| Concept | 3020891 Body temperature | `plausibleUnitConceptIds` 586323, 9289 |
| Concept | 3023103 Potassium [Moles/volume] in Serum or Plasma | units 8753, 9557 |
| Concept | 200962 Primary malignant neoplasm of prostate | `plausibleGender` Male |
| Concept | 37392176 Serum creatinine level | µmol/L 10–200, mg/dL 0.1–5 (5 %) |

**The concept level is thin.** Of its 527 rows:
- 291 are sex plausibility (prostate, pregnancy…).
- 181 are allowed unit lists for measurements.
- **only 9 carry value bounds**, all for cholesterol and creatinine. The
  creatinine upper bound of 200 µmol/L would flag a large share of an ICU
  population.
- `isTemporallyConstant` and `validPrevalenceLow/High` are columns with no check
  behind them.

There are no bounds for vital signs, no lab panel and nothing ICU-specific. Those
rule sets are **ours to write**.

**How often it changes**: the CSVs change a few times a year (2025: units,
thresholds, the `plausibleUnitConceptIds` check; 2026-03 and 2026-05: missing
units). The templates hardly change.

## 2. Thematic public rule sets

One public repo per rule set in `linkr-public-content/dq-rule-sets/`, each an
ordinary rule-set export tree, indexed by the catalog:

| Rule set | Source | Content |
|---|---|---|
| `omop-cdm-5.4-structure` | DQD table + field level | tables/fields present, types, required, PK/FK, FK domain/class, standard valid concept, completeness, date bounds, temporal order, during life, within visit |
| `omop-sex-plausibility` | DQD concept level (`plausibleGender*`) | ~290 conditions/procedures |
| `omop-measurement-units` | DQD concept level (`plausibleUnitConceptIds`) | 181 measurement concepts |
| `omop-lab-values` | ours (DQD's 9 bounds as a start) | plausible ranges per lab concept and unit |
| `omop-vital-signs` | ours | HR, BP, SpO₂, temperature, RR, weight, height… |
| `omop-icu` | ours | ICU-specific (ventilation, drips, scores…) |

The DQD-derived ones come from **a generator script** that lives in their repo:

1. Pin a DQD tag.
2. Expand check types × CSV rows the way `executeDqChecks` does (same
   `evaluationFilter`, same default thresholds), filtered to the rule set's theme.
3. Render each template and translate it to DuckDB (SqlRender has a DuckDB target —
   to verify). Split the result into `sql` (the count query) and `exploreSql`
   (the `violatedRows` block).
4. Write `checks.json` with stable check ids (see §4) derived from DQD's own
   `getCheckId()`, so a regenerated release diffs cleanly.

For the rule sets we write ourselves, the INDICATE data dictionaries
(`recommendedUnits`, `unitConversions`) are a natural source for units, and
possibly for ranges.

### Field mapping DQD → `DqCustomCheck`

| DQD | Linkr |
|---|---|
| `kahnCategory` / `kahnSubcategory` | `category` / `subcategory` (same taxonomy) |
| `kahnContext` Verification / Validation | new field, see decisions |
| `severity` fatal / convention / characterization | `severity` error / warning / notice |
| `…Threshold` (%) | `threshold` (%) |
| `checkDescription` rendered | `description` |
| `checkName` + table/field/concept | `name`, `tableName` (check group) |
| `getCheckId()` | stable check id (§4), `templateKey = dqd.<checkName>` |
| `notApplicable` rules | `total = 0 → N/A` covers most; DQD's extra cases to check one by one |

### Known issues

- **Vocabulary**: DQD's concept checks join `concept` / `concept_ancestor`.
  The vocabulary tables are **in every OMOP database** in Linkr, so the
  checks read them in place. No routing is needed.
- **Overlap** between `omop-cdm-5.4-structure` and our generated `ddl.*` /
  `mapping.*` checks (required, PK, FK, start ≤ end, during life). Say so in the
  README. A run that combines both counts some rules twice.
- **Volume**: the structure rule set is a few thousand checks. Test the checks
  list, a full run (client DuckDB-WASM and server), and the size of `checks.json`.
- **Dialect**: DuckDB first. Postgres needs a second rendering, or translation at run time.
- **Cohort mode** (DQD restricts checks to a cohort): out of scope; derive the
  cohort into its own database instead.

## 3. Quality profiles — a curated selection of checks, and its runs

Rule sets are **libraries of checks**: public ones (§2) and the workspace's own.
What runs against a database is a **quality profile** (FR *profil qualité*): a
saved, named selection of checks taken from any number of rule sets. It is
edited over time as the rule sets release new versions.

### Model

A profile **references** checks and never copies them. Provenance is therefore
always known: each entry names its rule set (by `lineageId`, portable) and the
check's `checkKey` (§4).

```
DqProfile
  name, description, dataSourceRef?        -- default database, optional
  sources: [
    { ruleSetRef, mode: 'all' | 'selected',
      checkKeys?: [...],                    -- mode 'selected'
      excludedKeys?: [...],                 -- mode 'all'
      acknowledgedVersion }                 -- rule set version last reviewed
  ]
  overrides?: { "<ruleSetLineage>#<checkKey>": { threshold?, severity? } }
```

- **`all`**: the whole rule set, minus exclusions. New checks from a release
  join automatically.
- **`selected`**: only the listed checks. New checks from a release are
  *offered*, never added silently.
- **Overrides**: threshold and severity per check, stored in the profile. The
  public rule set stays untouched, so its next release still applies cleanly.
  This matters because DQD's thresholds are not ICU thresholds. Changing a
  check's SQL is not an override: copy the check into one of your own rule sets
  (the copy records the rule set and `checkKey` it was derived from).

### Rule set releases

When a referenced rule set is updated (catalog refresh or git pull), the profile
compares it to `acknowledgedVersion` and shows a **review banner**:
- **added** checks: tick to include (`selected`) or to exclude (`all`);
- **removed** checks: listed as gone, then dropped from the profile;
- **changed** checks: SQL or threshold differs, with a diff. The profile follows
  the new version, and its overrides still apply.

"Mark as reviewed" bumps `acknowledgedVersion`. Until then the profile still runs.

### Runs

The DQ page gets the **concept-mapping layout**: a home with one widget card
per view, each view on its own URL (back button and shared links work):

| Widget | URL | Content |
|---|---|---|
| Rule sets | `…/data-quality/rule-sets` | the current list; a rule set opens as today |
| Quality profiles | `…/data-quality/profiles` | list; a profile opens on its check picker + release review |
| Runs | `…/data-quality/runs` | every run in the workspace, across profiles and databases |

The home cards are hand-built today in `MappingProjectListPage` (`view === 'home'`).
Extract them into a shared component used by both pages rather than copying
them, and add it to `docs/ui-patterns.md`.

- A run = one profile (or an ad-hoc pick) on one database.
- A run **snapshots** what it executed: for every check, its rule set lineage
  and version, `checkKey`, effective threshold/severity, and the SQL. A past run
  stays readable and reproducible after the rule sets move on, and its results
  can always be filtered by source rule set.
- A run can be **exported as DQV** (Turtle and JSON-LD, §5). QUANTUM's output
  is DCAT + DQV too, so the file can go to the same places (e.g. a FAIR Data
  Point). It is not a QUANTUM label: that is a questionnaire, see §7.

### Consequences for rule sets

- A rule set stops being tied to a database: `dataSourceId` becomes optional
  (the database is chosen by the profile or at run time). Running a single rule
  set directly stays possible, as a run with no profile.
- Rule-set `version` must be meaningful (bumped on every release), since profiles
  and runs pin it.
- A profile is a new exportable, versionable entity: `entity-io.ts` +
  `packages/linkr-format` schema + golden, catalog type `dq-profile`, git link. An
  exported profile carries its refs. On import, a referenced rule set that is
  missing is reported and can be installed from the catalog, like a mapping
  project's concept-set refs.

## 4. Stable check identifiers

DQV points every measurement at a metric, which must keep one identifier across
instances, exports and re-imports. Each check gets a **stable id**:

- `checkKey`: a slug set at creation and unique within its rule set. It is kept
  on export, import, duplication and catalog refresh. Generated checks derive it
  from their rule (`templateKey`, DQD `getCheckId()`); a handwritten one derives
  it from its name at creation and it never changes afterwards (renaming does
  not touch it).
- Metric IRI = the rule set's published IRI (catalog entry, else its
  `lineageId` under the instance base) + `#` + `checkKey`.
- Both homes: `entity-io.ts` + `packages/linkr-format` (rule-set checks schema),
  and the dq-rule-set golden.

The Kahn categories and subcategories become a small **published Linkr DQ
vocabulary** (static JSON-LD, e.g. on linkr.interhop.org) so dimensions resolve too.

## 5. DQV mapping

```
dqv:Category ─< dqv:Dimension ─< dqv:Metric
dcat:Dataset  dqv:hasQualityMeasurement  dqv:QualityMeasurement
              (dqv:computedOn <dataset>, dqv:isMeasurementOf <metric>, dqv:value)
```

| DQV | Linkr |
|---|---|
| `dqv:Category` | Kahn category |
| `dqv:Dimension` | Kahn subcategory (the category itself for completeness) |
| `dqv:Metric` | a check (§4 IRI) |
| `dqv:QualityMeasurement` | a check result of a run |

A pure `dqRunToDqv(run, datasetIri, { perCheck })` emits:
- **always** one measurement per Kahn dimension: the share of passed checks
  (≈ 6 values per run);
- **optionally** one measurement per check, with the % of violating rows. That
  can be thousands of values for the structure rule set.

The run export offers per-check as an option. The catalog publishes dimensions
only.

`datasetIri`: the database's catalog `dcat:Dataset` when one exists; otherwise
asked at export time.

## 6. Data catalog

- On **Publish**, take the latest successful run on the catalog's database and
  emit its dimension measurements into the HealthDCAT-AP JSON-LD. Add a "Data
  quality" section to the static page (score per Kahn dimension, run date, rule
  sets + versions, link to details). This page is also the "report URL"
  QUANTUM asks for.
- Latest run older than the data, or no run: **warn** at publish and say so on
  the page. Never block.
- Same change in both homes if the catalog stores anything new (e.g. which run
  to use instead of "latest"), plus the data-catalog golden.

## 7. QUANTUM

QUANTUM's output is an **RDF Turtle** file (DCAT + DQV + Web Annotation):
- the catalog and the dataset;
- a `dqv:QualityCertificate` whose `oa:hasBody` is the star rating;
- one `dqv:QualityMeasurement` per questionnaire metric, holding the declared value;
- an organisation maturity assessment.

It also produces a PDF report and a sunburst chart, and can push to a FAIR Data
Point. Its metric IRIs are placeholders (`http://fdp.com/…`), not a published
vocabulary.

Decision: **no QUANTUM correspondence column** for now. Its *Technical quality*
metrics mostly ask whether documentation exists. A column mapping our measured
dimensions onto them would suggest a QUANTUM score we do not compute, through
a correspondence that is ours, not theirs. Revisit if QUANTUM publishes stable
metric IRIs or an official mapping. Linkr's role is the evidence: the §6 page
as report URL, and DQV measurements.

So **nothing QUANTUM-specific is built**: no UI, no field, no export. QUANTUM is
named only in the user documentation (data catalog page on linkr-website): the
published quality page can be given as the report URL a QUANTUM or EHDS label
assessment asks for, and the DQV is the measured counterpart of its declared values.

## Decisions

1. ✅ Vocabulary tables are in every OMOP database — checks read them in place.
2. ✅ Stale results on publish → warn.
3. ✅ No QUANTUM column (§7).
4. ✅ Thematic rule sets (§2) and multi-rule-set runs (§3), instead of one DQD rule set.
5. ✅ **Kahn context** (Verification / Validation) as an optional check field
   (`kahnContext`, none today): filled by the DQD generator, editable on handwritten checks.
6. ✅ **DQV granularity**: dimensions always; per check opt-in on run export; the
   catalog publishes dimensions only.
7. ✅ **Saved selections**: DQ profiles (§3), at check granularity, referencing rule
   sets (provenance kept), with a review step on each rule set release.
8. ✅ Profile **overrides**: threshold and severity per check; changing SQL = copy
   the check into an own rule set (derived-from recorded).
9. ✅ Name: **quality profile** / *profil qualité*.
10. ✅ Layout: concept-mapping style home with three widgets (§3).

## Steps

| St | Item | Effort |
|----|------|--------|
| 🔜 | 1. Stable `checkKey` on checks (both homes + golden) + optional `kahnContext` | S |
| 🔜 | 2. Rule sets not tied to a database; meaningful `version` | S |
| 🔜 | 3a. DQ profiles: model, both homes + golden, Profiles tab, check picker across rule sets, overrides | M |
| 🔜 | 3b. Runs tab: run a profile on a database, per-check snapshot, results filtered by rule set, re-run | M |
| 🔜 | 3c. Release review: added / removed / changed checks against `acknowledgedVersion` | M |
| 🔜 | 4. DQD generator + `omop-cdm-5.4-structure`, `omop-sex-plausibility`, `omop-measurement-units` repos + catalog entries; run them on the MIMIC demo | M |
| 🔜 | 5. Published Linkr DQ vocabulary (Kahn dimensions) as JSON-LD | S |
| 🔜 | 6. `dqRunToDqv()` + tests; run export as Turtle / JSON-LD | S |
| 🔜 | 7. Catalog publish: DQV in the JSON-LD + "Data quality" section, stale warning | M |
| 💤 | 8. Write `omop-lab-values`, `omop-vital-signs`, `omop-icu` (clinical input needed) | L |
| 🔜 | 9. `docs/architecture.md` + user doc on linkr-website (DQ runs, DQV export, catalog quality section, QUANTUM mention §7) | S |
