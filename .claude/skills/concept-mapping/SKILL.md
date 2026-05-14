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

## Step 0: Check existing state and offer review page

Before anything else, if a project is already known (from a prior session in the same conversation, or because the user names a project), check whether `<project_dir>/state.json` exists. If it does, read it and tell the user where things stand in one sentence:

> "MIMIC-IV → OMOP — 320/1234 mapped (26%), scores computed (jaro-winkler + biolord), last session 2h ago on Measurement."

Then ask: **"Do you want me to launch the review server so you can browse the dashboard?"** If yes, run:

```bash
python -m http.server 8765 --directory <project_dir>
```

with `Bash` + `run_in_background: true`, and tell the user to open `http://localhost:8765/review/`. The review page reads `state.json` (one level up from `/review/`) and shows progress, methods computed, recent sessions, and file status.

If `<project_dir>/review/` does not exist yet, copy the template:

```bash
cp -R .claude/skills/concept-mapping/review-template <project_dir>/review
```

If `state.json` is missing or stale, run `update_state.py` first (see Step 4 hook).

## Step 1: Load configuration

Read `config.local.json` at the **project root** (not in the skill folder). If it exists and has a `concept-mapping` section, use those values silently. Fall back to prompting for any missing path.

```json
{
  "concept-mapping": {
    "vocab_dir":     "/path/to/ohdsi-vocabularies",
    "models_dir":    "/path/to/bert-models-cache",
    "projects_dir":  "/path/to/mapping-projects"
  }
}
```

Derived paths (never ask the user for these — compute them automatically):
- `embeddings_file` = `vocab_dir/concept_embeddings.parquet` (co-located with CONCEPT.parquet)
- `project_dir` = `projects_dir/<project-name>` (folder for the current project)
- `similarity_scores` = `project_dir/similarity-scores.parquet`
- `source_embeddings` = `project_dir/source_embeddings.parquet`

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

## Step 3b: Normalize source CSV columns

Before passing the source CSV to `compute_scores.py`, verify that it contains the three required columns: `terminology`, `concept_code`, `concept_name`.

If any are missing, inspect the actual columns and apply this heuristic to propose a mapping:

| Required column | Candidate patterns (case-insensitive) |
|---|---|
| `terminology` | `terminology`, `terminology_code`, `vocab`, `vocabulary`, `source_vocab` |
| `concept_code` | `concept_code`, `code`, `source_code`, `local_code` |
| `concept_name` | `concept_name`, `concept_label`, `label`, `name`, `description` |

Show the user a mapping table like this and ask for confirmation:

```
Columns found in the file:
  terminology_code → terminology   ✓ (auto-detected)
  concept_code     → concept_code  ✓ (exact match)
  concept_label    → concept_name  ✓ (auto-detected)

Other columns (category, patients_count, …) will be ignored.
Is this correct?
```

If the user confirms, generate a temporary normalized CSV (`/tmp/<original-name>-normalized.csv`) with only the three renamed columns, and use that path as `--source` for the script. If the user corrects the mapping, apply their corrections before writing the temp file.

If a required column cannot be matched even heuristically, list the actual columns and ask the user to specify the mapping explicitly.

## Step 4: Precompute suggestions (syntactic + semantic)

These two Python scripts live in `.claude/skills/concept-mapping/scripts/`. Run them when the user wants fresh suggestions, or when `similarity-scores.parquet` is missing/stale.

Both scripts are long-running (minutes to hours). Before launching one, ask the user **how they want to run it**:

> "These scripts can take a long time. Two options:
>
> 1. **Run it yourself in a terminal (recommended)** — copy the command below, paste it into your terminal. No extra token cost.
> 2. **I run it via Monitor** — I stream progress here, but every progress line costs tokens (can be significant over hours)."

If the user picks **option 1**, print the exact command in a copy-paste block and stop. When they come back and say it's done (or interrupted), continue with the next step (verify the output file, refresh `state.json`).

If the user picks **option 2**, launch with `Monitor` and `persistent: true` (no timeout). Filter aggressively to keep token cost down (see grep patterns below). Do NOT use `run_in_background` for these scripts.

### Script 1 — embed_concepts.py (run once per vocabulary release)

Generates BioLORD-2023-M embeddings for all OMOP concepts. **Supports resume**: if the output file already exists, already-encoded concepts are skipped automatically. Safe to interrupt and restart.

```bash
TRANSFORMERS_CACHE=<models_dir> python \
  .claude/skills/concept-mapping/scripts/embed_concepts.py \
  --concept <vocab_dir>/CONCEPT.parquet
  # output defaults to <vocab_dir>/concept_embeddings.parquet (co-located with CONCEPT.parquet)
# Optional filters: --only-standard --only-valid --domain Measurement Condition --vocabulary LOINC SNOMED
# Optional: --flush-every 50  (append to parquet every N batches, default 50 = ~25k concepts)
```

Output: `<vocab_dir>/concept_embeddings.parquet` — columns: `concept_id`, `encoded_text`, `model_id`, `embedding`.
Runtime: can be several hours on CPU for large vocabularies (~4M concepts). The file is written incrementally every 50 batches, so progress is never lost on interrupt.

The script prints progress lines every 10 batches and flush confirmations every 50 batches:
```
[embed] batch 10/7991 — 5,120/4,091,099 concepts (0.1%) — 201 concepts/s — ETA 338m46s
[flush] 5,120 embeddings saved to concept_embeddings.parquet
```

**Recommended: hand off to the user's terminal.** A full run takes several hours; streaming every `[embed]` line through `Monitor` burns thousands of tokens for no benefit. Tell the user it is safer and cheaper to paste the command in their own terminal and come back when done — the script is resume-safe, so an interrupt loses at most one flush window (~25k concepts).

If the user explicitly wants `Monitor`, use `persistent: true` and filter for `[flush]` only (skip `[embed]`) to cut the notification volume by 5×:
```
\[flush\]|Done|Error|Traceback
```

### Script 2 — compute_scores.py (run per project)

Computes syntactic and semantic similarity scores for all source concepts in the project. Also saves source concept embeddings alongside the scores.

```bash
TRANSFORMERS_CACHE=<models_dir> python \
  .claude/skills/concept-mapping/scripts/compute_scores.py \
  --source     <project_dir>/source-concepts.csv \
  --concept    <vocab_dir>/CONCEPT.parquet \
  --embeddings <vocab_dir>/concept_embeddings.parquet
  # output defaults to <project_dir>/similarity-scores.parquet
  # source embeddings default to <project_dir>/source_embeddings.parquet
# Optional: --top-k 50 --flush-every 100
# Optional: --methods syntactic/jaro-winkler syntactic/token-sort syntactic/ngram-idf semantic/biolord
# Optional filters: --only-standard --only-valid --domain --vocabulary
```

Default methods: `syntactic/jaro-winkler` + `semantic/biolord`. **Do not add `syntactic/ngram-idf` unless the user explicitly asks** — it requires building a full bigram IDF index over all OMOP concepts (~4M), which takes ~1 hour on CPU.

Output written to `<project_dir>/`:
- `similarity-scores.parquet` — long format: `source_vocabulary_id | source_concept_code | concept_id | method | score | equivalence | comment | created_at`
  - For `syntactic/*` and `semantic/*` methods: `equivalence` is always `"skos:exactMatch"` and `comment` is `null`.
  - These columns exist so AI-generated rows (method `ai/<model-id>`, written by `/concept-mapping-ai` when the user picks the "suggestions" mode) can carry nuanced SKOS equivalence and a justification.
  - A `statistical/*` method prefix is reserved for distributional similarity (comparing value distributions, e.g. KS or Wasserstein on `info_json.numerical_data`) — not yet implemented. See `reference.md`.
- `source_embeddings.parquet` — BioLORD embeddings of the source concepts (reused if scores are extended)
**Supports resume**: if the output file already exists, already-scored `(source_vocabulary_id, source_concept_code)` pairs are skipped. Safe to interrupt and restart.

The user loads this file in Linkr (Suggestions tab → "Load scores file") to populate pre-computed suggestions.

Inform the user of estimated runtime based on source concept count × OMOP concept count.

Progress tags emitted by the script:
- `[syntactic]` — every 10 source concepts (jaro-winkler, token-sort)
- `[index]` — every 500k concepts during ngram-idf index build
- `[semantic]` — every 50 source concepts (biolord)
- `[flush]` — every `--flush-every` source concepts (default 100)

**Same trade-off as `embed_concepts.py`**: recommend running it in the user's terminal. If they want `Monitor`, use `persistent: true` with a flush-only filter to limit token cost:
```
\[flush\]|\[index\]|Done|Error|Traceback
```

## Step 5: AI mapping (route to sub-skill)

Based on the selected concepts' inferred domain, recommend the appropriate sub-skill:

| Concept domain | Sub-skill |
|---|---|
| Measurement, Condition, Procedure, Observation | `/concept-mapping-ai` |
| Drug (medications, prescriptions) | `/concept-mapping-drug` |
| Mixed batch | Run `/concept-mapping-ai` first, then `/concept-mapping-drug` for Drug concepts |

The sub-skill itself asks the user (at session start) whether its output should land in `similarity-scores.parquet` (as AI suggestions, default) or directly in `mappings.json` (as authored mappings), and who the author is. See the sub-skill's SKILL.md for the exact prompts.

Tell the user which sub-skill will handle the batch and why. Then invoke it.

Pass along:
- Project files (`project.json` path, `mappings.json` path, `source-concepts.csv` path)
- Vocabulary location
- Selected concept list (or filter to re-derive it)
- `similarity-scores.parquet` path if available
- `projectId` from `project.json`

## Step 6: Persist sub-skill output

The sub-skill returns a list of rows plus a `mode` flag telling you where to write them:

- `mode = "suggestions"` → append to `similarity-scores.parquet` with `method = "ai/<model-id>"`, populating `equivalence`/`comment`/`created_at`. Use the same parquet schema as `compute_scores.py`. Never overwrite existing rows for the same `(source_vocabulary_id, source_concept_code, concept_id, method)` key.
- `mode = "mappings"` → append to `mappings.json` (existing flow below).

### Writing mappings.json (mode = "mappings")

1. Read the current `mappings.json`
2. Append new mappings — **never overwrite existing ones**
3. Write back the full array
4. Report: N new mappings added, N concepts still unmapped
5. Refresh `state.json` and record the session:

```bash
python .claude/skills/concept-mapping/scripts/update_state.py \
  --project-dir <project_dir> \
  --vocab-dir   <vocab_dir> \
  --session '{"subSkill":"concept-mapping-ai","concepts":["REA/x","REA/y"],"outcomes":{"accepted":8,"flagged":1,"skipped":1}}'
```

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
