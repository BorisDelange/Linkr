---
name: concept-mapping
description: >-
  Orchestrates OMOP concept mapping for a Linkr project. Entry point for all
  mapping work: loads inputs, runs precomputation scripts, and routes to
  sub-skills (concept-mapping-ai, concept-mapping-drug) based on concept domain.
  Use when the user wants to map local hospital terminology codes to OMOP standard
  vocabularies (SNOMED CT, LOINC, UCUM, RxNorm, etc.).
argument-hint: [path-to-project-zip-or-folder]
---

# Concept Mapping — Orchestrator

Read `reference.md` in this directory for type definitions, DuckDB query patterns, and SSSOM equivalence guidelines.

## Step 1: Load configuration

Read `config.local.json` at the **project root** (not in the skill folder). If it exists and has a `concept-mapping` section, use those values silently. Fall back to prompting for any missing path.

```json
{
  "concept-mapping": {
    "vocab_dir":        "/path/to/ohdsi-vocabularies",
    "models_dir":       "/path/to/bert-models-cache",
    "embeddings_file":  "/path/to/concept_embeddings.parquet",
    "scores_dir":       "/path/to/scores-output-dir",
    "export_dir":       "/path/to/mapping-exports"
  }
}
```

Tell the user which values were loaded from config and which will be prompted.

## Step 2: Gather inputs

### 2a. Mapping project

Accept ONE of:
- **ZIP file**: exported Linkr project (contains `project.json`, `mappings.json`, `source-concepts.csv`)
- **Folder**: unzipped project folder with the same files
- **Individual files**: explicit paths to `mappings.json` and `source-concepts.csv`

Read `project.json` to understand project context. Extract `projectId` for use in mappings.

### 2b. OHDSI vocabulary location

Use `vocab_dir` from config if set. Otherwise prompt.

Required: `CONCEPT` (parquet or CSV). Strongly recommended: `CONCEPT_SYNONYM`, `CONCEPT_RELATIONSHIP`, `CONCEPT_ANCESTOR`.

### 2c. Concept selection

Ask how to select source concepts. Show a preview (count + 5-row sample) before proceeding.

1. **By category** — filter on `full_name` from `info_json` (e.g., "Laboratoire", "Respiratoire")
2. **Top N by frequency** — sorted by `record_count` DESC or `patient_count` DESC
3. **By name pattern** — SQL `ILIKE` pattern on `concept_name`
4. **Specific codes** — list of concept codes
5. **All unmapped** — concepts absent from `mappings.json`
6. **Custom SQL** — any DuckDB WHERE clause on source_concepts

### 2d. Optional filters

- **Target vocabularies**: default all (`standard_concept = 'S'`). Can restrict to LOINC, SNOMED, RxNorm, etc.
- **Target domains**: Measurement, Condition, Drug, Procedure, Observation, etc.

## Step 3: Load data into DuckDB

```bash
duckdb /tmp/concept-mapping-session.duckdb
```

```sql
CREATE TABLE concept          AS SELECT * FROM read_parquet('<vocab_dir>/CONCEPT.parquet');
CREATE TABLE concept_synonym  AS SELECT * FROM read_parquet('<vocab_dir>/CONCEPT_SYNONYM.parquet');
CREATE TABLE concept_relationship AS SELECT * FROM read_parquet('<vocab_dir>/CONCEPT_RELATIONSHIP.parquet');
CREATE TABLE concept_ancestor AS SELECT * FROM read_parquet('<vocab_dir>/CONCEPT_ANCESTOR.parquet');
CREATE TABLE source_concepts  AS SELECT * FROM read_csv('<project>/source-concepts.csv', auto_detect=true);
CREATE TABLE existing_mappings AS SELECT * FROM read_json('<project>/mappings.json', auto_detect=true, format='array');

CREATE INDEX idx_concept_name ON concept(concept_name);
CREATE INDEX idx_concept_std  ON concept(standard_concept);
CREATE INDEX idx_synonym_name ON concept_synonym(concept_synonym_name);
CREATE INDEX idx_rel_c1       ON concept_relationship(concept_id_1);
CREATE INDEX idx_rel_c2       ON concept_relationship(concept_id_2);
```

For CSV vocabularies, replace `read_parquet` with `read_csv(..., auto_detect=true)`.

## Step 4: Precompute similarity scores (optional but recommended)

These two Python scripts live in `.claude/skills/concept-mapping/scripts/`. Run them when the user wants fresh scores, or when `scores.parquet` is missing/stale.

### Script 1 — embed_concepts.py (run once per vocabulary release)

Generates BioLORD-2023-M embeddings for all OMOP concepts.

```bash
TRANSFORMERS_CACHE=<models_dir> python \
  .claude/skills/concept-mapping/scripts/embed_concepts.py \
  --concept <vocab_dir>/CONCEPT.parquet \
  --output  <embeddings_file>
# Optional filters: --only-standard --only-valid --domain Measurement Condition --vocabulary LOINC SNOMED
```

Output: `concept_embeddings.parquet` — columns: `concept_id`, `encoded_text`, `model_id`, `embedding`.
Runtime: 30–120 min on CPU. Skip if `embeddings_file` already exists and vocabulary hasn't changed.

### Script 2 — compute_scores.py (run per project)

Computes syntactic and semantic similarity scores for all source concepts in the project.

```bash
TRANSFORMERS_CACHE=<models_dir> python \
  .claude/skills/concept-mapping/scripts/compute_scores.py \
  --source     <project>/source-concepts.csv \
  --concept    <vocab_dir>/CONCEPT.parquet \
  --embeddings <embeddings_file> \
  --output     <scores_dir>/<project-name>-scores.parquet
# Optional: --top-k 50 --methods syntactic/jaro-winkler syntactic/token-sort syntactic/ngram-idf semantic/biolord
# Optional filters: --only-standard --only-valid --domain --vocabulary
```

Output: `scores.parquet` — long format: `source_vocabulary_id | source_concept_code | concept_id | method | score`.

The user loads this file in Linkr (Suggestions tab → "Load scores file") to populate pre-computed suggestions.

Inform the user of estimated runtime based on source concept count × OMOP concept count.

## Step 5: Route to sub-skill

Based on the selected concepts' inferred domain, recommend the appropriate sub-skill:

| Concept domain | Sub-skill |
|---|---|
| Measurement, Condition, Procedure, Observation | `/concept-mapping-ai` |
| Drug (medications, prescriptions) | `/concept-mapping-drug` |
| Mixed batch | Run `/concept-mapping-ai` first, then `/concept-mapping-drug` for Drug concepts |

Tell the user which sub-skill will handle the batch and why. Then invoke it.

Pass along:
- Project files (project.json path, mappings.json path, source-concepts.csv path)
- Vocabulary location
- Selected concept list (or filter to re-derive it)
- `scores.parquet` path if available
- `projectId` from project.json

## Step 6: Write mappings

After the sub-skill returns approved mappings, write them to `mappings.json`.

1. Read the current `mappings.json`
2. Append new mappings — **never overwrite existing ones**
3. Write back the full array
4. Report: N new mappings added, N concepts still unmapped

Source concept uniqueness key: `(sourceVocabularyId, sourceConceptCode)`. Check existing mappings before adding.

See `reference.md` for the full `ConceptMapping` JSON structure.

## Step 7: Summary

After each batch:
1. Summary table: source name → target name, vocabulary, equivalence, status
2. Remaining unmapped concept count
3. Ask whether to continue with the next batch or switch domain/sub-skill

## Cleanup

```bash
rm -f /tmp/concept-mapping-session.duckdb
```
