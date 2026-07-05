---
name: concept-mapping-ai
description: >-
  Agentic sub-skill for OMOP concept mapping. Maps source clinical concepts
  (measurements, conditions, procedures, observations) to OMOP standard concepts
  using DuckDB search, web search, and clinical reasoning. Called by the
  concept-mapping orchestrator — do not invoke directly unless you already have
  a loaded DuckDB session and project context.
---

# Concept Mapping — Agentic (Claude)

Read `.claude/skills/concept-mapping/references/omop-duckdb-reference.md` for type definitions, DuckDB query patterns, and SSSOM equivalence guidelines.

## Context expected from the orchestrator

By the time this skill runs, the following are already in place:
- DuckDB session at `/tmp/concept-mapping-session.duckdb` with tables: `concept`, `concept_synonym`, `concept_relationship`, `concept_ancestor`, `source_concepts`, `existing_mappings`
- `project.json` read → `projectId` known
- Source concept batch selected and previewed
- `similarity-scores.parquet` path (may be absent if not precomputed)
- **Optionally, data-dictionary priority mode** (from the orchestrator's Step 2e): a `dict_targets(concept_id, concept_set_uid, source_repo, category, subcategory, set_name)` table, the dictionary folder path, an active `category`, and an **iteration direction** (`source-first` | `dictionary-first`). When present, follow the full protocol in `.claude/skills/concept-mapping/references/data-dictionary.md` (align onto the dictionary first, OMOP fallback, `longDescription`/Mapping Notes authority, stamping). The direction decides which loop Step 2 runs.

## Step 0: Decide where the AI output goes

At the start of every session, ask the user the following questions before processing any concept:

**Q1 — Destination** (default: suggestions)
> "Should my AI matches land in `similarity-scores.parquet` as **suggestions** (a Linkr reviewer accepts/rejects them later in the UI), or directly in `mappings.json` as **authored mappings**?"

- `suggestions` → write rows with `method = "ai/<model-id>"`. Use the actual model ID (e.g. `claude-opus-4-7`).
- `mappings` → write full `ConceptMapping` objects with `status: "unchecked"`.

**Q2 — Author** (only if `mappings` was chosen)
> "Author for these mappings: me (Claude, model = `<current-model-id>`) or you?"

- If "Claude" → `mappedBy = "Claude Opus 4.7"` (or whichever model is active).
- If "user" → ask for first + last name, then `mappedBy = "<First Last>"`.

**Q3 — Top-K** (only if `suggestions` was chosen, default: 5)
> "How many candidates per source concept should I propose? (default: 5)"

**Q4 — Per-batch review** (only if `suggestions` was chosen, default: no)
> "Do you want to review each batch before I flush it to the parquet, or should I run autonomously?"

- `no` (default) → flush each batch directly without asking. The user reviews everything later in the Linkr UI.
- `yes` → at the end of each batch, present the table and require confirmation before flushing (same flow as `mappings` mode below).

In `mappings` mode, per-batch confirmation is implicit — every concept always requires explicit user confirmation before being written.

Store these choices for the whole session — do not re-ask between batches unless the user asks to change them.

## Step 1: Load pre-computed scores (if available)

If `similarity-scores.parquet` was provided, load it:

```sql
CREATE TABLE precomputed_scores AS
  SELECT * FROM read_parquet('<project_dir>/similarity-scores.parquet')
  WHERE source_vocabulary_id = '<vocab>' AND source_concept_code IN (<batch_codes>);
```

Filter out rows with `method LIKE 'ai/%'` if you only want non-AI signals. Use these scores to prioritize DuckDB search candidates. A concept with `semantic/biolord` score > 0.90 is a strong lead — verify it, don't skip the reasoning step.

## Step 2: Process concepts in batches

**If data-dictionary priority mode is active with direction `dictionary-first`,
run the inverted loop instead of the source-by-source loop below** — iterate
over `dict_targets` (one category at a time), and for each target collect and
align *all* the source concepts that fit it (N sources → 1 target), presenting
grouped by target. The full dictionary-first execution steps, the multi-source
rule, and the end-of-category coverage report live in
`.claude/skills/concept-mapping/references/data-dictionary.md` ("Two iteration
directions"). The candidate evaluation (2c), edge cases (2e), and output schema
(Step 3) are identical to below; only the loop variable and presentation change.

Otherwise (plain OMOP, or dictionary priority with direction `source-first`),
process source concept by source concept:

Default batch size: 10. Ask the user if they want a different size.

For each source concept in the batch:

### 2a. Understand the source concept

1. Read `concept_name` — translate to English if in French or abbreviated
2. Read `info_json` fields:
   - `full_name`: hierarchical path (e.g., "Laboratoire / Labo_GDS / PaO2")
   - `data_types`: "numerical" or "categorical"
   - `numerical_data`: unit, min, max, mean — validates the mapping
   - `categorical_data`: possible values — reveals what the concept represents
   - `hospital_units`: clinical context (ICU, step-down, etc.)
3. Infer OMOP domain (see domain heuristics in `references/omop-duckdb-reference.md`)

### 2b. Search for candidates

Apply strategies in order. Stop when you have ≥ 3 strong candidates.

**Strategy 1 — Pre-computed scores**
If `scores.parquet` loaded, retrieve top candidates for this concept. High `semantic/biolord` score (> 0.85) with matching domain is a strong signal.

**Strategy 2 — Direct name search**
Search `concept` and `concept_synonym` with the English translation. See DuckDB patterns in `references/omop-duckdb-reference.md`.

**Strategy 3 — Keyword decomposition**
Break the name into clinical keywords. Search combinations. Useful for compound terms (e.g., "Pression artérielle systolique" → "systolic" + "arterial" + "pressure").

**Strategy 4 — Web search**
Use WebSearch when:
- The concept is a specific lab test with a known LOINC panel
- The concept refers to a clinical score or index (SOFA, GCS, APACHE)
- The local name is an abbreviation with multiple possible meanings
Search for: `LOINC "heart rate"`, `SNOMED CT "respiratory rate"`, `OMOP concept "SpO2"`.

**Strategy 5 — Hierarchy traversal**
Once a candidate is found, explore ancestors/descendants via `concept_ancestor` and `concept_relationship` (relationship_id = 'Maps to') to find the right specificity level.

**Data-dictionary priority (when `dict_targets` is provided)**

When the orchestrator passed a `dict_targets` table + dictionary folder path +
active `category`, the target-selection order changes: align onto the dictionary
first, OMOP fallback only when nothing fits. The full protocol —
`concept_sets_resolved/` vs `expression.items[]` (the classification-node trap),
the `longDescription`/Mapping Notes authority, the four-branch resolution order,
and `concept_set_uid`/`concept_set_source_repo` stamping — lives in
`.claude/skills/concept-mapping/references/data-dictionary.md`. Read it now and
follow it for this batch.

### 2c. Evaluate and rank candidates

For each candidate:
1. **Semantic equivalence** — does it mean the same thing?
2. **Granularity** — right level of specificity for the source?
3. **Domain consistency** — OMOP domain matches data_type?
4. **Unit compatibility** — for measurements: does the LOINC expect the same unit as `numerical_data.unit`?
5. **Standard status** — prefer `standard_concept = 'S'` over `'C'` or non-standard

Assign SSSOM equivalence level (see `references/omop-duckdb-reference.md` for full guidelines):
- `skos:exactMatch` — truly identical meaning, no information loss
- `skos:closeMatch` — very similar but some qualifier lost (method, device, location, timing)
- `skos:broadMatch` — target is more general
- `skos:narrowMatch` — target is more specific
- `skos:relatedMatch` — related but different angle

**Be rigorous: default to `closeMatch`, not `exactMatch`.** Use exactMatch only when concepts are fully equivalent with no qualifiers lost.

### 2d. Present to user

The presentation flow depends on the destination chosen at Step 0:

**Mode `mappings` (authored)** — present each source concept individually and require explicit user confirmation before writing. A mapping written here lands directly in `mappings.json` as `status: unchecked`, so every concept must be accepted by hand.

```
Source: <concept_name> [<terminology>/<code>]
  Category: <full_name from info_json>
  Type: <numerical|categorical> | Unit: <unit> | Freq: <record_count> records

Candidate 1 (recommended):
  <concept_id> — <concept_name> [<vocabulary_id>]
  Domain: <domain_id> | Class: <concept_class_id> | Standard: <S|C>
  Equivalence: skos:<level>
  Reasoning: <one or two sentences explaining what is preserved and what is lost>
  Pre-computed scores: syntactic/jaro-winkler=0.92, semantic/biolord=0.89

Candidate 2 (alternative):
  ...

→ Options: [1] Accept candidate 1  [2] Accept candidate 2  [3] Enter custom concept_id  [4] Flag for review  [5] Mark as ignored  [6] Skip
```

Never write a `mappings.json` row without explicit user confirmation.

**Mode `suggestions`** — behavior depends on Q4 (per-batch review) chosen at Step 0.

- **Q4 = no (default, autonomous)**: present the whole batch as a compact recommendation table for transparency, then flush directly to `similarity-scores.parquet` without asking. The user's approval happens later in the Linkr UI.
- **Q4 = yes**: present the table and require the user to confirm before flushing each batch — same pattern as the `mappings` mode above.

Recommended format for the batch table:

```
| # | Source | Top candidate | Equiv | Score | Comment |
|---|---|---|---|---|---|
| 1 | <vocab>/<code> <name> | <cid> <concept_name> [<voc> <dom>] | <skos:level> | <0.0–1.0> | <one-line justification> |
| ... |
```

### 2e. Handle edge cases

- **No good match**: explain why (too specific, administrative concept, no equivalent in OMOP), suggest `status: ignored` or `status: flagged`
- **Multiple equally good candidates**: present both, ask user to choose
- **Non-standard concept found**: use `concept_relationship` with `Maps to` to find the standard equivalent
- **Drug concept in non-drug batch**: note it, defer to `/concept-mapping-drug`

## Step 3: Return the batch to the orchestrator

Return both the `mode` chosen at Step 0 (`"suggestions"` or `"mappings"`) and the rows. The orchestrator handles writing.

### If mode = "suggestions"

Return one or more rows per source concept (up to top-K, per Q3), matching the parquet schema used by `compute_scores.py`:

| Field | Value |
|---|---|
| `source_vocabulary_id` | from the source concept |
| `source_concept_code` | from the source concept |
| `concept_id` | OMOP target concept id |
| `method` | `"ai/<model-id>"` (e.g. `"ai/claude-opus-4-7"`) |
| `score` | 0.0–1.0 confidence (top candidate 0.85+, weaker ones lower) |
| `equivalence` | one of `skos:exactMatch`, `closeMatch`, `broadMatch`, `narrowMatch`, `relatedMatch` |
| `comment` | one short sentence justifying the match (free text, can include unit/granularity notes) |
| `created_at` | ISO 8601 UTC timestamp |
| `concept_set_uid` | `metadata.uniqueId` of the data-dictionary concept set the target came from (data-dictionary priority mode, branches 1–2). `null` for full-OMOP fallback targets. |
| `concept_set_source_repo` | `metadata.sourceRepo` of that dictionary (lets Linkr offer "import this dictionary" when the set is absent locally). `null` whenever `concept_set_uid` is null. |

This is the only place in the system where `equivalence` is nuanced — for `syntactic/*` and `semantic/*` it is always `skos:exactMatch`, `comment` is null, and both `concept_set_*` columns are null.

### If mode = "mappings"

Return a list of approved `ConceptMapping` objects (see `references/omop-duckdb-reference.md` for full structure). The orchestrator writes them to `mappings.json`.

Key fields to populate:
- `mappedBy`: from Q2 — either `"Claude Opus 4.7"` (use actual current model name) or `"<First Last>"`
- `status`: `"unchecked"` (user approved during session, but not yet reviewed by a second person)
- `comments`: one comment with two lines — description of the mapping, then equivalence justification
- `matchScore`: 0.0–1.0 based on your confidence (exactMatch + strong pre-computed score → 0.95+; closeMatch with uncertainty → 0.6–0.75)

## Guidelines

- **Translate before searching** — French concept names must be translated to English before DuckDB queries
- **info_json is gold** — units, ranges, and categorical values often disambiguate between two near-identical LOINC codes
- **Don't re-map** — always check `existing_mappings` before processing a concept
- **One concept at a time** — present one source concept fully before moving to the next
- **Cite your reasoning** — the comment field is read by human reviewers; make it useful
