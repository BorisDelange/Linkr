# Mapping — drug concepts (RxNorm / RxNorm Extension)

Read this when the selected batch is **Drug domain** (medications,
prescriptions). It replaces the generic clinical procedure in `mapping-ai.md`
for drugs, because generic fuzzy name matching fails for them. Both share the
same DuckDB session, type definitions, and SSSOM guidelines from
`omop-duckdb-reference.md`.

## Why drug mapping is different

Generic fuzzy name matching fails for drugs. "Paracetamol 500 MG Oral Tablet"
and "Paracetamol 1000 MG Oral Tablet" score nearly identically on string
similarity, but are clinically distinct. Accurate mapping needs two separate
things, and the whole procedure below turns on keeping them apart:

- **Finding candidates** — "which drugs *resemble* my source?" This is what the
  pre-computed similarity scores do well (see the search evidence below). They
  reliably surface the right **ingredient**, even across brand names and
  languages — but they are **blind to the exact strength**.
- **Deciding among candidates** — "which candidate has the *same* ingredient,
  strength and form as my source?" This is what the parsed components
  (ingredient + strength + form) are for. Parsing does **not** drive the search
  anymore; it drives **validation**.

The search leg proposes; the validation leg disposes. Never let a similarity
score settle a strength — a 2× dosage difference is a clinical error that scores
near-identically.

### Search evidence (why scores, not ILIKE)

On the French UCD gold set (287 of the top-300 UCD codes, expert double-validated,
benchmarked against this project's `similarity-scores.parquet`), measured as
"does the top-K candidate shortlist contain a drug with the correct RxNorm
ingredient?":

- `semantic/biolord` reached **66.8% at top-1**, 73.6% at top-10, 77.3% at top-50.
- `syntactic/jaro-winkler` was lower everywhere (57–66%).
- A naive ILIKE on the French label reached ~50%, and on the **51% of codes that
  are brand names / abbreviations** (LOXEN, FORXIGA, ASPEGIC, JARDIANCE…) it
  collapsed to **9.7%**, versus 48.7% for biolord top-10.
- **Zero** codes were found by ILIKE that biolord + jaro-winkler top-10 missed.

Conclusion baked into this procedure: **use the pre-computed scores as the
primary candidate source** (biolord first, jaro-winkler as a secondary signal);
keep ingredient/ATC/RxNorm traversal only as a **fallback** when scores are
absent or the shortlist yields nothing valid.

## Target the most granular standard concept the source supports

The OMOP rule is: map to the **most specific, most granular standard concept**
the source information allows — not a fixed level. RxNorm + RxNorm Extension
expose a hierarchy of standard (`standard_concept = 'S'`) concept classes. Pick
the highest row below that the source actually renders, then descend one level
only if that concept does not exist in the loaded vocabulary.

| `concept_class_id` | Carries | Choose when the source renders… |
|---|---|---|
| **Branded Drug Box** | brand + strength + form + packaging | a brand name **and** packaging/box |
| **Quant Branded Drug** | brand + quantified strength + form | a brand name **and** a quantity/volume (e.g. 5 MG/ML in a 10 ML vial) |
| **Branded Drug** | brand + strength + form | a **brand name** + strength + form |
| **Quant Clinical Drug** | ingredient + quantified strength + form | a quantity/volume, no brand |
| **Clinical Drug** | ingredient + strength + form | generic name + strength + form |
| **Clinical Drug Form** | ingredient + form (no strength) | strength absent or unreadable in the source |
| **Ingredient** | ingredient only | last resort → `skos:broadMatch` |

`vocabulary_id` may be `RxNorm` or `RxNorm Extension` (RxE carries internationally
used concepts absent from US RxNorm) — accept both, always `standard_concept = 'S'`
and `invalid_reason IS NULL`. When the source carries a brand name, **default to
the branded level** — that is the most granular representation and preserves the
brand; fall back to the generic Clinical Drug family only when no branded standard
concept matches.

## Context in place before this procedure runs

- DuckDB session at `/tmp/concept-mapping-session.duckdb`
- Tables loaded: `concept`, `concept_synonym`, `concept_relationship`, `concept_ancestor`, `source_concepts`, `existing_mappings`
- `projectId` known
- Source concept batch filtered to Drug domain
- `similarity-scores.parquet` path (may be absent — then Step 2 falls back to Step 3)
- Destination + author choices from `mapping-ai.md` Step A already made for the session (suggestions vs mappings, top-K, per-batch review). If this batch is the first of the session, ask those questions now (same wording as `mapping-ai.md` Step A) before processing.

## Step 1: Parse the source drug label

Parse **once per source concept**, up front. This does not search — it produces
the reference values Step 4 validates candidates against. Extract from
`concept_name` and `info_json`:

| Component | Example | Where to find it |
|---|---|---|
| **Ingredient(s)** | paracetamol; amoxicillin + clavulanate | concept_name, translate to INN |
| **Strength** | 500 MG, 2 MG/ML, 4 G/500 MG | concept_name or `categorical_data` / `numerical_data` |
| **Dose form** | Oral Tablet, Injectable Solution | concept_name or `full_name` category |
| **Brand name** | LOXEN, FORXIGA, AUGMENTIN | concept_name (leading token, often a proprietary name) |

- Translate ingredient names from French/local to INN (International
  Nonproprietary Name) in English — including spelling differences
  (salbutamol → albuterol, aciclovir → acyclovir).
- Strength regex: `(\d+(?:[.,]\d+)?)\s*(mg|g|mcg|µg|ml|%|UI|IU|UNT)` (case-insensitive);
  normalise the decimal separator and the unit before comparing.
- Record whether a **brand name** is present — it decides the target granularity
  (branded vs generic level, per the table above).

## Step 2: Find candidates — pre-computed similarity scores (primary)

Load this source concept's candidates from `similarity-scores.parquet`:

```sql
SELECT s.concept_id, c.concept_name, c.concept_class_id, c.vocabulary_id,
       s.method, s.score
FROM read_parquet('<project_dir>/similarity-scores.parquet') s
JOIN concept c ON c.concept_id = s.concept_id
WHERE s.source_vocabulary_id = '<vocab>'
  AND s.source_concept_code   = '<code>'
  AND s.method IN ('semantic/biolord', 'syntactic/jaro-winkler')  -- exclude ai/* rows
  AND c.standard_concept = 'S' AND c.invalid_reason IS NULL
ORDER BY (s.method = 'semantic/biolord') DESC, s.score DESC;
```

Take the top-K per method as the shortlist (biolord is the stronger signal —
prioritise it; jaro-winkler is a secondary tie-breaker, useful mainly when the
local label is already close to the INN). These candidates are **leads to
validate**, never answers: a high biolord score fixes the *ingredient*, not the
*strength*.

Carry every plausible ingredient forward to Step 4 — the shortlist typically
spans several strengths and forms of the right ingredient; Step 4 picks the one
that matches.

## Step 3: Fallback — relationship traversal (only if Step 2 is empty)

Use this **only** when `similarity-scores.parquet` is absent, has no row for this
code, or no shortlist candidate survives Step 4. It is the autonomous search.

### 3a. Find the ingredient concept (INN + ATC + synonyms)

```sql
-- RxNorm Ingredient for the translated INN
SELECT concept_id, concept_name, vocabulary_id, concept_class_id, standard_concept
FROM concept
WHERE concept_class_id = 'Ingredient' AND vocabulary_id LIKE 'RxNorm%'
  AND standard_concept = 'S' AND concept_name ILIKE '%paracetamol%'
ORDER BY length(concept_name) LIMIT 10;
```

For local trade names not resolvable to an INN, search synonyms:

```sql
SELECT DISTINCT c.concept_id, c.concept_name, c.vocabulary_id, c.concept_class_id
FROM concept_synonym cs JOIN concept c ON cs.concept_id = c.concept_id
WHERE cs.concept_synonym_name ILIKE '%doliprane%'
  AND c.standard_concept = 'S' AND c.invalid_reason IS NULL LIMIT 20;
```

And ATC, traversing to standard RxNorm via `Maps to`:

```sql
SELECT c2.concept_id, c2.concept_name, c2.vocabulary_id, c2.concept_class_id
FROM concept_relationship cr JOIN concept c2 ON cr.concept_id_2 = c2.concept_id
WHERE cr.concept_id_1 = <atc_concept_id>
  AND cr.relationship_id IN ('Maps to', 'ATC - RxNorm', 'ATC - RxNorm pr lat')
  AND c2.standard_concept = 'S' AND c2.invalid_reason IS NULL;
```

### 3b. Enumerate products of that ingredient at the target granularity

```sql
-- All standard drug products under the ingredient, at the class you're targeting
SELECT DISTINCT c2.concept_id, c2.concept_name, c2.concept_class_id, c2.vocabulary_id
FROM concept_ancestor ca JOIN concept c2 ON ca.descendant_concept_id = c2.concept_id
WHERE ca.ancestor_concept_id = <ingredient_concept_id>
  AND c2.concept_class_id IN ('Branded Drug','Quant Branded Drug','Branded Drug Box',
                              'Clinical Drug','Quant Clinical Drug')
  AND c2.standard_concept = 'S' AND c2.invalid_reason IS NULL
ORDER BY c2.concept_name LIMIT 100;
```

These enumerated products then go through the **same Step 4 validation** as the
score shortlist.

## Step 4: Validate and pick — the component filter

For each candidate (from Step 2, or Step 3 fallback), compare the parsed source
components against the candidate. This is where strength and form decide.

| Component | Pass condition |
|---|---|
| **Ingredient** | Same INN (all ingredients, for combinations). Confirm via web search if uncertain. |
| **Strength** | **Strict**: numerically equal or mathematically equivalent (500 MG = 0.5 G; 2 MG/ML = 200 MG/100 ML). Never approximate. |
| **Dose form** | **Exact**: same form. Only lexical variants of the *same* form are allowed ("oral tablet" ≈ "tablet", "solution injectable" ≈ "injectable solution"). A genuinely different form (tablet vs capsule, tablet vs solution) is **not** an exact form match. |

### Equivalence and outcome

Assign the SSSOM equivalence from what actually matched (see
`omop-duckdb-reference.md` for the full ladder):

- Ingredient = , strength = , form exact (or lexical variant) → **`skos:exactMatch`**.
- Ingredient = , strength = , **form clinically related but not the same**
  (e.g. disintegrating tablet vs plain tablet) → **`skos:closeMatch`**, and the
  comment MUST name the form difference (per `mapping-ai.md` C4).
- Source has **no strength** but ingredient + form match a Clinical Drug Form →
  **`skos:narrowMatch`** (target more specific) or **`broadMatch`** as the
  direction dictates, documented.
- No standard drug product matches but the ingredient is unambiguous → map to
  **Ingredient**, **`skos:broadMatch`**, documented.

### Hard stops — flag, never force

Flag (do not map) when:
- **Strength differs** and is not mathematically equivalent — this is the single
  most important guard; approximating a dose is a clinical error, not a close
  match. Flag rather than pick the nearest dose.
- Homeopathic / diluted products with no clear single INN.
- The source is a drug *category*, not a specific drug (e.g. "beta-blockers").
- Combination product where an ingredient cannot be resolved.

For a combination drug, all ingredients must be present in the target; map to the
combination product, and list the ingredients in the comment.

## Step 5: Web search for difficult cases

Use WebSearch when:
- INN translation is uncertain (trade name not found in synonyms)
- Multiple ingredients (combination drug) → search each ingredient separately
- Biosimilars or biologics with ambiguous naming

Search patterns: `RxNorm "amoxicillin 500 mg oral tablet"`,
`OMOP concept drug "paracetamol"`, `INN "doliprane"` (trade name → INN).

## Step 6: Present candidates to user

For each source drug concept:

```
Source: <concept_name> [<terminology>/<code>]
  Category: <full_name>
  Parsed: ingredient=<INN> | strength=<value unit> | form=<dose form> | brand=<brand|—>
  Records: <record_count> | Patients: <patient_count>

Candidate source: <pre-computed scores | traversal fallback | web search>

Candidate 1 (recommended):
  <concept_id> — <concept_name> [<vocabulary_id>, <concept_class_id>]
  Ingredient: ✓ | Strength: ✓ 500 MG | Form: ✓ Oral Tablet
  biolord=0.91  jaro-winkler=0.74
  Equivalence: skos:<level>
  Reasoning: <one sentence — follow the comment rules in mapping-ai.md C4; for a
             closeMatch state the form difference explicitly>

Candidate 2 (if applicable): ...

→ Options: [1] Accept  [2] Accept candidate 2  [3] Enter custom concept_id
           [4] Map to ingredient only (broadMatch)  [5] Flag  [6] Skip
```

**Option 4 — Map to ingredient only**: when no drug product matches but the
ingredient is unambiguous → `skos:broadMatch`.

Presentation and confirmation follow the destination mode chosen at Step A of
`mapping-ai.md`: in `mappings` mode confirm each concept by hand; in
`suggestions` mode, autonomous unless per-batch review was requested.

## Step 7: Persist the batch

Write according to the session `mode` (same rules as `mapping-ai.md` Step D).
For `mappings` mode, key fields:
- `targetConceptId`: the most granular matching standard concept (branded level when the source is branded), or RxNorm Ingredient for broadMatch
- `mappedBy`: "Claude Opus 4.8" (actual model name) or the user's name
- `status`: "unchecked"
- `matchScore`: 0.95 for a full ingredient+strength+form match, 0.75 for ingredient+form only, 0.5 for ingredient only
- `comments`: candidate source + which components matched, and — for any inexact equivalence — exactly what differs (form, missing strength…)

For `suggestions` mode, use `method = "ai/<model-id>"` and the same 10-column
parquet schema as `mapping-ai.md` Step D (`concept_set_*` null unless a data
dictionary drove the target). Then refresh `state.json` and return to the
orchestrator's Step 7 summary.

## Guidelines

- **Scores find, components decide** — pre-computed biolord/jaro-winkler build the shortlist; parsed ingredient/strength/form validate and rank it. Never let a score settle a strength.
- **Target the most granular standard concept** the source supports (branded when a brand name is present), descending only if that concept does not exist.
- **Strength is strict** — equal or mathematically equivalent, else flag. A 2× dosage difference is a clinical error, not a close match.
- **Form must match exactly** — only lexical variants of the same form are allowed; a different form is at best a `closeMatch` with the difference spelled out, never a silent exactMatch.
- **Prefer ingredient-level mapping over no mapping** — a documented `broadMatch` to Ingredient beats a flag, when the ingredient is unambiguous.
- **Combination drugs** — every ingredient must be present in the target; list them in the comment.
- **Homeopathic/diluted products** — cannot be meaningfully mapped; mark `ignored` with explanation.
- **Check existing mappings** — do not re-map concepts already in `mappings.json`.
