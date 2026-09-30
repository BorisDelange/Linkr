# Workspace vocabularies & data dictionaries — plan

Status: ✅ phases 1–4 built 2026-09-28 (branch `feature/workspace-vocabularies`); to test in the app. As-built: `docs/architecture.md`.. Branch `feature/workspace-vocabularies`.

## Why

Today an OHDSI vocabulary (ATHENA) and the concept sets are **per mapping project**
in practice, although both are stored at workspace level:

- **Vocabulary**: each mapping project imports its own ATHENA as a hidden
  `DataSource` (`isVocabularyReference`), pointed at by
  `vocabularyDataSourceId`. Three imports = three databases, no reuse. The
  exported `vocabularyDataSourceRef` carries an instance-local, random
  `lineageId` (vocabulary DBs are never exported), so it resolves nowhere and
  flips in git between two users who each imported ATHENA.
- **Concept sets**: workspace rows, but a mapping project only sees the ids in
  its `conceptSetIds` — which the export drops ("re-derivable", but nothing
  re-derives them). Deleting sets from a project deletes them from the
  workspace. `resolvedConceptIds` is never computed (the "resolved" view fetches
  `concept_sets_resolved/` from GitHub). Import duplicates on re-import (no
  `uniqueId` dedup). Units (conversions, recommended units) are not imported.
- Consumers beyond mapping projects: the warehouse **Concepts** page (sets
  indexed by vocabulary+code, "replace dictionary"), MCP (`list_concept_sets`,
  `search_vocabulary`, `add_ai_suggestions` by `uniqueId`), scores
  (`concept_set_uid`), ETL (`vocab.` role = the pipeline's mapping project's
  vocabulary DB).

## Target model

Both become **workspace resources**, managed in **Workspace settings**, used by
every feature of the workspace. Mapping projects stop owning them.

### 1. Vocabulary library (one per workspace)

- One library per workspace, **partitioned by vocabulary**: each
  `vocabulary_id` is held once, at one `vocabulary_version` (read from the
  export's `VOCABULARY` table). The shared small tables (`domain`,
  `concept_class`, `relationship`, `vocabulary`) are the union, latest wins.
- **Import an ATHENA export** → a per-vocabulary preview: *new* (added),
  *same version* (skipped — the rows are already there), *other version*
  (replace, or keep the current one). SNOMED then SNOMED+LOINC = LOINC added,
  SNOMED untouched if same version.
- Rows are attributed to the vocabulary that brings them: `concept` by its
  `vocabulary_id`; `concept_relationship` / `concept_ancestor` /
  `concept_synonym` / `drug_strength` by the vocabulary of their first concept.
  Replacing a vocabulary replaces its partition only. OMOP keeps `concept_id`
  stable across releases, so cross-vocabulary links stay valid.
- Exposed to DuckDB exactly as today's vocabulary DB (views `concept`,
  `concept_ancestor`, … over the union of partitions), so the mapping editor,
  concept detail, ETL `vocab.` role and MCP keep their queries.
- Library page: vocabularies with version, row counts, size, import date; remove
  a vocabulary; import.
- **No pointer in exports**: every mapping project of the workspace uses the
  workspace library. `vocabularyDataSourceId/Ref` removed (model, export, MCP
  `vocabulary_database_id`), migration moves existing vocabulary DBs into the
  library.
- Storage: server = parquet partitions under `data_dir/vocabularies/<ws>/<vocab>/<table>.parquet`
  (DuckDB). Front-only = the same partitions in OPFS, written by DuckDB-WASM
  (a full CONCEPT is ~5 M rows: feasible, but the slow path — see decision 3).

### 2. Data dictionaries

- New workspace entity **data dictionary**: `{name, sourceRepo, branch, commit,
  syncedAt, dataHash}` owning its **concept sets**, **unit conversions** and
  **recommended units**. Hand-imported sets (file/URL) go in a local dictionary.
- **Import from a repo** with the INDICATE layout: `concept_sets/*.json`,
  `units/unit_conversions.json`, `units/recommended_units.json` (+ `projects/`
  later). Server mode clones (existing `clone_to_zip`); front-only reads through
  the forge's raw API.
- **Update**: re-sync → preview keyed by `metadata.uniqueId` (added / new
  version / removed / units changed) → apply. Replaces the per-set "update from
  remote" and the Concepts page "replace dictionary".
- Concept sets keep their table, gain `dictionaryId`; dedup on `uniqueId`
  within a dictionary.
- **Resolution** computed locally against the vocabulary library (included ∪
  descendants via `concept_ancestor` ∪ mapped via `concept_relationship`
  Maps to/Mapped from, minus excluded — INDICATE `resolve.py`), stored in
  `resolvedConceptIds` with the vocabulary versions used; re-run when the
  library or the dictionary changes.
- **SQL generation**: port of INDICATE `buildOMOPSQL` (domain → table, standard
  concepts only, reference unit = most shared recommended unit, affine
  conversion `value * factor + offset`, flat or per-concept nested CASE,
  optional unit filter) as a pure TS module, pinned by the golden fixtures of
  `data-dictionary` branch `feat/core-extraction-mcp` (`tests/fixtures/sql/`).
  Shown in the concept set sheet (SQL tab, reference-unit picker).

### 3. Mapping projects, exports, deletion

- A mapping project **selects** concept sets from the workspace dictionaries
  (no import from the project any more). Export writes them portably:
  `conceptSets: [{sourceRepo, uniqueId}]` in `entity.json`; import resolves
  them against the workspace dictionaries and lists the missing ones (with the
  repo to import).
- Removing a set from a project **detaches** it; deleting from the workspace
  happens only in the dictionary settings, and warns about the projects using it.
- Workspace export: **a dictionary is never embedded** in the workspace repo
  (decided 2026-09-30). It exports as a pointer (repo URL + ref/commit + name) so an
  import re-downloads it; vocabularies are not exported either (too big — the
  inventory `vocabulary_id` + version is, so an import can say what is missing).
  Open: what a dictionary with no repo (local import) becomes.

## Phases

| # | Item | Effort |
|---|------|--------|
| 1 | Drop `vocabularyDataSourceRef` from exports; detach instead of delete; portable concept-set refs in mapping-project export/import (+ format package) | S–M |
| 2 | Vocabulary library: model + storage + import with per-vocabulary version preview + Settings tab; switch consumers (mapping editor, ConceptSetsTab browse, concept detail, ETL `vocab.`, MCP); migrate existing vocabulary DBs | L |
| 3 | Data dictionaries: model (+ units tables), repo import/update with preview, Settings tab; Concepts page + mapping project + MCP read from it | L |
| 4 | Local resolution against the library + SQL generation port (goldens) | M |
| 5 | `docs/architecture.md` (user docs: [website-docs.md](website-docs.md)) | S |

## Decisions (2026-09-28)

1. **One vocabulary library per workspace**, one version per vocabulary. A newer
   ATHENA release preselects "replace" for every vocabulary whose version moved;
   keeping some gives a mixed library (concept ids are stable and deprecated
   concepts stay, so links hold; only a few cross-vocabulary ancestors can lag),
   shown per vocabulary with a "mixed releases" warning.
2. **Any repo URL** following the INDICATE layout (INDICATE, SFAR, forks);
   INDICATE offered by default. Today bulk import is hard-wired to
   `indicate-eu/data-dictionary-content` and URL import takes one set.
3. **Full front-only parity**: the partitioned library lives in OPFS too,
   written by DuckDB-WASM.

## As built (differences from the plan above)

- Front-only, the library is **not rewritten** into partitions (a full ATHENA does
  not fit in the browser): each import stays a hidden vocabulary database and the
  library's views read each vocabulary from its owner. Server-side it is rewritten.
- The library's metadata lives on its data source (`connectionConfig.vocabularies`),
  not in a table of its own.
- Not done yet: the workspace export still embeds every concept set in full
  (`concept-sets/*.json`) instead of a dictionary pointer; no vocabulary inventory;
  the pull of `conceptSets` refs (see the planning README).
