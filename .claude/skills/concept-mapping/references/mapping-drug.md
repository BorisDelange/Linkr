# Mapping — drug concepts (RxNorm Clinical Drug)

Read this when the selected batch is **Drug domain** (medications,
prescriptions). It replaces the generic clinical procedure in `mapping-ai.md`
for drugs, because generic fuzzy name matching fails for them. Both share the
same DuckDB session, type definitions, and SSSOM guidelines from
`omop-duckdb-reference.md`.

## Why drug mapping is different

Generic fuzzy name matching fails for drugs. "Paracetamol 500 MG Oral Tablet" and "Paracetamol 1000 MG Oral Tablet" score nearly identically on string similarity, but are clinically distinct. Accurate mapping requires matching three structured components: **active ingredient**, **dosage strength**, and **pharmaceutical form**.

The target in OMOP is always an RxNorm **Clinical Drug** (`concept_class_id = 'Clinical Drug'`, `vocabulary_id = 'RxNorm'`, `standard_concept = 'S'`).

## Context in place before this procedure runs

- DuckDB session at `/tmp/concept-mapping-session.duckdb`
- Tables loaded: `concept`, `concept_synonym`, `concept_relationship`, `concept_ancestor`, `source_concepts`, `existing_mappings`
- `projectId` known
- Source concept batch filtered to Drug domain
- Destination + author choices from `mapping-ai.md` Step A already made for the session (suggestions vs mappings, top-K, per-batch review). If this batch is the first of the session, ask those questions now (same wording as `mapping-ai.md` Step A) before processing.

## Step 1: Parse the source drug label

For each source concept, extract three components from `concept_name` and `info_json`:

| Component | Example | Where to find it |
|---|---|---|
| **Ingredient** | Paracetamol, Amoxicillin | concept_name, may need translation |
| **Strength** | 500 MG, 1 G | concept_name or `categorical_data` values |
| **Dose form** | Oral Tablet, Injectable Solution | concept_name or `full_name` category |

Use `categorical_data` from `info_json` to identify administered forms or strengths. Use `numerical_data` (min/max/unit) to infer concentration ranges.

Translate ingredient names from French/local to INN (International Nonproprietary Name) in English.

## Step 2: Strategy A — Relationship traversal

Walk OMOP's built-in relationships from less specific to more specific concepts.

### 2a. Find ingredient concept

```sql
-- Find the RxNorm Ingredient for the INN name
SELECT concept_id, concept_name, vocabulary_id, concept_class_id, standard_concept
FROM concept
WHERE concept_class_id = 'Ingredient'
  AND vocabulary_id = 'RxNorm'
  AND standard_concept = 'S'
  AND concept_name ILIKE '%paracetamol%'   -- use INN name
ORDER BY length(concept_name)
LIMIT 10;
```

Also search ATC:
```sql
SELECT concept_id, concept_name, vocabulary_id, concept_class_id
FROM concept
WHERE vocabulary_id LIKE 'ATC%'
  AND concept_name ILIKE '%paracetamol%'
LIMIT 10;
```

### 2b. Traverse to Clinical Drug via relationships

```sql
-- From ingredient, find all Clinical Drug descendants
SELECT DISTINCT
  c2.concept_id, c2.concept_name, c2.vocabulary_id,
  c2.concept_class_id, c2.standard_concept
FROM concept_ancestor ca
JOIN concept c2 ON ca.descendant_concept_id = c2.concept_id
WHERE ca.ancestor_concept_id = <ingredient_concept_id>
  AND c2.concept_class_id = 'Clinical Drug'
  AND c2.standard_concept = 'S'
  AND c2.invalid_reason IS NULL
ORDER BY c2.concept_name
LIMIT 50;
```

Then filter the results by matching the parsed strength and dose form from Step 1.

### 2c. ATC → RxNorm via "Maps to"

```sql
-- If ATC concept found, traverse to standard RxNorm via Maps to
SELECT c2.concept_id, c2.concept_name, c2.vocabulary_id,
       c2.concept_class_id, c2.standard_concept
FROM concept_relationship cr
JOIN concept c2 ON cr.concept_id_2 = c2.concept_id
WHERE cr.concept_id_1 = <atc_concept_id>
  AND cr.relationship_id IN ('Maps to', 'ATC - RxNorm', 'ATC - RxNorm pr lat')
  AND c2.standard_concept = 'S'
  AND c2.invalid_reason IS NULL;
```

## Step 3: Strategy B — Component extraction + structured search

Use when Strategy A returns no result or too many results.

### 3a. Extract components programmatically

Parse the source label with regex or heuristics:
- Strength pattern: `(\d+(?:\.\d+)?)\s*(mg|g|mcg|ml|%|UI|IU)` (case-insensitive)
- Dose form keywords: tablet, capsule, injectable, solution, syrup, patch, suppository, inhaler

### 3b. Search by ingredient + strength combination

```sql
-- Find Clinical Drugs matching ingredient name + strength
SELECT concept_id, concept_name, vocabulary_id, concept_class_id
FROM concept
WHERE concept_class_id = 'Clinical Drug'
  AND standard_concept = 'S'
  AND invalid_reason IS NULL
  AND concept_name ILIKE '%paracetamol%'
  AND concept_name ILIKE '%500%'
  AND concept_name ILIKE '%oral%'
ORDER BY length(concept_name)
LIMIT 20;
```

### 3c. Use concept_synonym for local trade names

Many local hospital systems use trade names (Doliprane, Efferalgan) rather than INNs. Search synonyms:

```sql
SELECT DISTINCT c.concept_id, c.concept_name, c.vocabulary_id, c.concept_class_id
FROM concept_synonym cs
JOIN concept c ON cs.concept_id = c.concept_id
WHERE cs.concept_synonym_name ILIKE '%doliprane%'
  AND c.standard_concept = 'S'
  AND c.invalid_reason IS NULL
LIMIT 20;
```

## Step 4: Validate the match

Before proposing a mapping, validate all three components match:

| Check | Pass condition |
|---|---|
| **Ingredient** | Same INN, confirmed via web search if uncertain |
| **Strength** | Exact numeric match, or mathematically equivalent (500 mg = 0.5 g) |
| **Dose form** | Compatible forms: "oral tablet" ≈ "tablet", "solution injectable" ≈ "injectable solution" |

Fail conditions (do NOT map, flag instead):
- Dosage differs and is NOT mathematically equivalent
- Dose form incompatible (oral vs. injectable)
- Homeopathic or combination products with no clear single INN
- Source is a drug category rather than a specific drug (e.g., "beta-blockers")

## Step 5: Web search for difficult cases

Use WebSearch when:
- INN translation is uncertain (trade name not found in synonyms)
- Multiple ingredients (combination drug) → search each ingredient separately
- Biosimilars or biologics with ambiguous naming

Search patterns:
- `RxNorm "amoxicillin 500 mg oral tablet"` — direct RxNorm lookup
- `OMOP concept drug "paracetamol" Clinical Drug`
- `INN "doliprane"` — trade name → INN conversion

## Step 6: Present candidates to user

For each source drug concept:

```
Source: <concept_name> [<terminology>/<code>]
  Category: <full_name>
  Parsed: ingredient=<INN> | strength=<value unit> | form=<dose form>
  Records: <record_count> | Patients: <patient_count>

Strategy used: <relationship traversal | component extraction | web search>

Candidate 1 (recommended):
  <concept_id> — <concept_name> [RxNorm, Clinical Drug]
  Ingredient match: ✓ | Strength match: ✓ 500 MG | Dose form match: ✓ Oral Tablet
  Equivalence: skos:exactMatch
  Reasoning: <one sentence — follow the comment rules in mapping-ai.md C4>

Candidate 2 (if applicable):
  ...

→ Options: [1] Accept  [2] Accept candidate 2  [3] Enter custom concept_id
           [4] Map to ingredient only (broadMatch)  [5] Flag  [6] Skip
```

**Option 4 — Map to ingredient only**: use when no Clinical Drug matches but the ingredient is unambiguous. This is a `skos:broadMatch` (ingredient is more general than a specific drug product).

Presentation and confirmation follow the destination mode chosen at Step A of
`mapping-ai.md`: in `mappings` mode confirm each concept by hand; in
`suggestions` mode, autonomous unless per-batch review was requested.

## Step 7: Persist the batch

Write according to the session `mode` (same rules as `mapping-ai.md` Step D).
For `mappings` mode, key fields:
- `targetConceptId`: RxNorm Clinical Drug concept_id (preferred), or RxNorm Ingredient for broadMatch
- `mappedBy`: "Claude Opus 4.8" (actual model name) or the user's name
- `status`: "unchecked"
- `matchScore`: 0.95 for full 3-component match, 0.75 for ingredient+form only, 0.5 for ingredient only
- `comments`: strategy used + which components matched/mismatched

For `suggestions` mode, use `method = "ai/<model-id>"` and the same 10-column
parquet schema as `mapping-ai.md` Step D (`concept_set_*` null unless a data
dictionary drove the target). Then refresh `state.json` and return to the
orchestrator's Step 7 summary.

## Guidelines

- **Always target RxNorm Clinical Drug** — not Ingredient, not Clinical Drug Form, not Branded Drug
- **Strength must match** — a 2× dosage difference is a clinical error, not a close match
- **Prefer ingredient-level mapping over no mapping** — broadMatch to Ingredient is better than flagged
- **Combination drugs** — map to the primary active ingredient with a note in comments listing secondary ingredients
- **Homeopathic/diluted products** — cannot be meaningfully mapped; mark as `ignored` with explanation
- **Check existing mappings** — do not re-map concepts already in `mappings.json`
