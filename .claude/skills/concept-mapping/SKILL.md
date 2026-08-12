---
name: concept-mapping
version: 1.0.2
description: >-
  Maps local hospital terminology codes to OMOP standard vocabularies (SNOMED CT,
  LOINC, UCUM, RxNorm, etc.) for a Linkr project. Single entry point: loads inputs,
  runs precomputation scripts, then follows the domain-appropriate mapping procedure
  (references/mapping-ai.md for clinical concepts, references/mapping-drug.md for drugs).
argument-hint: [path-to-project-zip-or-folder]
---

# Concept Mapping

Read `references/omop-duckdb-reference.md` in this directory for type definitions, DuckDB query patterns, and SSSOM equivalence guidelines.

**This skill is versioned** (`version:` above + `CHANGELOG.md`). A publication using it cites **"Linkr concept-mapping skill v&lt;version&gt;"** with the `version:` value above. **Whenever you modify any file in this skill folder** (`SKILL.md`, `references/*`, `scripts/*`, `review-template/*`), bump `version:` per SemVer and add a dated `CHANGELOG.md` entry in the same change — MAJOR for a breaking change to invocation/inputs/output schema, MINOR for a new capability, PATCH for clarifications or fixes. Keep the frontmatter version and the top changelog entry in sync.

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

**If the mapping project is a git repo** (a `.git` folder in `project_dir`, or the user gave a repo URL/clone), the precompute scripts will drop large generated artifacts into it — `similarity-scores.parquet`, `source_embeddings.parquet`, and `source-concepts-normalized.csv`. These are derived, can be regenerated, and are large; they must **never** be versioned. Ensure the repo's `.gitignore` ignores them:

- Read `project_dir/.gitignore` (create it if absent).
- For each of the three entries not already present, append it.
- Tell the user plainly what you added, e.g. *"Added `similarity-scores.parquet`, `source_embeddings.parquet` and `source-concepts-normalized.csv` to the repo's `.gitignore` — these generated files stay out of version control."*

Do this before running any script in Step 4. (Consistent with Linkr's export convention: strip volatile/large artifacts, gitignore parquet, opt into git-LFS only when the user wants the data itself versioned.)

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

### 2e. Data-dictionary priority mode (optional)

If the user points at a **curated data dictionary** (a folder of OHDSI
concept-set JSON files) or mentions aligning "onto a data dictionary / concept
sets", offer to align onto it in priority with OMOP fallback. **Never assume a
dictionary folder — the user must name one.**

When this mode is active, read `references/data-dictionary.md` — it holds the
full protocol (folder layout, building `dict_targets`, category-by-category
processing, target selection, stamping).

**Then ask which iteration direction to use — this is the key choice, explain
the nuance clearly. Both directions resolve the same target (dictionary first,
OMOP fallback) and write the same rows; what changes is *what you loop over* and
therefore *what gets fully covered*.**

> "Two ways to drive this, depending on what you want covered:
>
> **1. Source-first (default).** I go through **your source concepts** one by
> one, and for each I find the best target — a dictionary concept set if one
> fits, otherwise the full OMOP vocabulary. This guarantees every one of *your
> local codes* is looked at, dictionary or not. Best when the goal is *'map all
> of my hospital terminology'*.
>
> **2. Dictionary-first.** I go through **the dictionary's concept sets** one by
> one (category by category), and for each target I pull *all* the source
> concepts that align onto it and map them together. This guarantees every
> *concept set* gets filled in turn — you never lose track of which sets are
> still empty, and you fill your alignments toward all the sets fast, without
> getting lost. A single set can receive several sources (e.g. several local
> 'heart rate' codes → the same set). Source concepts that match *no* dictionary
> set are **not** mapped in this mode — I list them at the end so you can run a
> source-first pass over them afterwards.
>
> In short: source-first covers all *your codes*; dictionary-first covers all
> *the dictionary's sets*. Which one?"

At this step (Step 2e) you only build the `dict_targets` table and the candidate
shortlist; the actual mapping then follows `references/mapping-ai.md` with the
dictionary folder path, the active category, **and the chosen direction**
(`source-first` | `dictionary-first`) in scope. All target selection happens in
that procedure; the direction only tells it which loop to run.

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

This loads the **full** `source-concepts.csv` (all columns, including `info_json`/`metadata_json`) — that is what the AI mapping in Step 5 needs. The 3-column normalization below is only for the precompute scripts, not for AI mapping.

## Step 4: Precompute suggestions (syntactic + semantic) — only if needed

Only when the user wants **fresh suggestions**, or `similarity-scores.parquet` is
missing/stale. For simple mapping of an existing batch, skip to Step 5.

### Step 4a: Normalize source CSV columns (for the scripts only)

The precompute scripts read only three columns: `terminology`, `concept_code`, `concept_name`. This normalization is **exclusively** a pre-condition of `compute_scores.py` — it does **not** apply to Step 5 (AI mapping still uses the full CSV loaded in Step 3).

Verify the source CSV contains those three columns. If any are missing, inspect the actual columns and apply this heuristic to propose a mapping:

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

If the user confirms, generate a normalized CSV **inside the project folder** at `<project_dir>/source-concepts-normalized.csv` with only the three renamed columns, and use that path as `--source` for the script. If the user corrects the mapping, apply their corrections before writing the file. (The script derives default output paths from `--source`'s parent folder, so keeping the normalized CSV in `<project_dir>/` makes `similarity-scores.parquet` and `source_embeddings.parquet` land in the right place.)

If a required column cannot be matched even heuristically, list the actual columns and ask the user to specify the mapping explicitly.

### Step 4b: Run the scripts

Two scripts in `.claude/skills/concept-mapping/scripts/`:
- `embed_concepts.py` — BioLORD embeddings for OMOP concepts (run **once per
  vocabulary release**, shared across projects).
- `compute_scores.py` — syntactic + semantic scores for the project's source
  concepts (run **per project**). Needs the embeddings from the first script for
  semantic scores.

Both are long-running, resume-safe, and have a **memory pitfall that can OOM a
laptop**. Before launching either, read `references/running-scripts.md` for when
to run each, the terminal-vs-Monitor decision, the mandatory target filters, and
the grep patterns. Run `python <script> --help` for the full flag list — that is
the source of truth for flags, resume semantics, and the FAISS cache.

The output `similarity-scores.parquet` schema (and its resume/idempotency rules)
is documented in `references/omop-duckdb-reference.md`. The user loads it in Linkr (Suggestions tab →
"Load scores file").

## Step 5: AI mapping (load the domain procedure)

> **⚠️ The mapping procedure needs the FULL `source-concepts.csv`** — all columns, including `info_json`/`metadata_json` (`full_name`, units, ranges, categorical values, hospital units…). This metadata is what disambiguates near-identical targets. **Never** use `source-concepts-normalized.csv`: that 3-column file (Step 4a) exists only for `compute_scores.py`. The `source_concepts` table loaded in Step 3 already holds the full CSV — use it.

Based on the selected concepts' inferred domain, read the matching reference file in this directory and follow it for the batch:

| Concept domain | Procedure to read |
|---|---|
| Measurement, Condition, Procedure, Observation | `references/mapping-ai.md` |
| Drug (medications, prescriptions) | `references/mapping-drug.md` |
| Mixed batch | Follow `mapping-ai.md` first for the non-drug concepts, then `mapping-drug.md` for the Drug concepts |

That procedure asks the user (at session start) whether output should land in `similarity-scores.parquet` (as AI suggestions, default) or directly in `mappings.json` (as authored mappings), and who the author is, then does the mapping and the persistence (its Step D) itself. Keep in scope while following it:

- Project files (`project.json`, `mappings.json`, the **full** `source-concepts.csv` — never the normalized one)
- Vocabulary location
- Selected concept list (or filter to re-derive it)
- `similarity-scores.parquet` path if available
- `projectId` from `project.json`
- **If data-dictionary priority mode (Step 2e) is active**: the `dict_targets` table (or dictionary folder path), the active `category`, the chosen **iteration direction** (`source-first` | `dictionary-first`), and the instruction to align onto the dictionary first with OMOP fallback. Stamp `concept_set_uid` + `concept_set_source_repo` on every suggestion whose target is a dictionary concept.

## Step 6: Record the session

The mapping procedure (Step D of `mapping-ai.md` / Step 7 of `mapping-drug.md`) already writes rows to `similarity-scores.parquet` or `mappings.json`. Both enforce the same invariants — recall them here:

- **suggestions** → `method = "ai/<model-id>"`, populate `equivalence`/`comment`/`created_at`, plus `concept_set_uid`/`concept_set_source_repo` when the target came from a data dictionary (null otherwise). Same 10-column parquet schema as `compute_scores.py`. Never overwrite an existing row for the same `(source_vocabulary_id, source_concept_code, concept_id, method)` key.
- **mappings** → append to `mappings.json`, never overwriting; key on `(sourceVocabularyId, sourceConceptCode)`. See `references/omop-duckdb-reference.md` for the full `ConceptMapping` structure.

After the batch is persisted, refresh `state.json` and record the session:

```bash
python .claude/skills/concept-mapping/scripts/update_state.py \
  --project-dir <project_dir> \
  --vocab-dir   <vocab_dir> \
  --session '{"domain":"Measurement","concepts":["REA/x","REA/y"],"outcomes":{"accepted":8,"flagged":1,"skipped":1}}'
```

And **if the batch wrote to `mappings.json`**, refresh the project's counters — Linkr displays `project.json`'s `stats` as-is and never recomputes them at import, so skipping this shows a stale `mappedCount`:

```bash
python .claude/skills/concept-mapping/scripts/update_project_stats.py --project-dir <project_dir>
```

## Step 7: Summary

After each batch:
1. Summary table: source name → target name, vocabulary, equivalence, status
2. Remaining unmapped concept count
3. Ask whether to continue with the next batch or switch domain (clinical ↔ drug procedure)

## Cleanup

```bash
rm -f /tmp/concept-mapping-session.duckdb
```
