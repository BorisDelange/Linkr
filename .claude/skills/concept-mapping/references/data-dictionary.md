# Data-dictionary priority mode

Read this only when the user wants to align source concepts **onto a curated data
dictionary** (a folder of OHDSI concept-set JSON files) in priority, falling back
to the full OMOP vocabulary only when no dictionary target fits. This is the
single source of truth for dictionary mapping — both the orchestrator (input
prep) and `/concept-mapping-ai` (target selection) point here. Skip it entirely
for plain OMOP mapping.

The INDICATE Data Dictionary is one such dictionary, but any concept-set
collection in this format works. Never assume a dictionary folder — the user
points at one, or mentions aligning "onto a data dictionary / concept sets".

## Offer the mode

When a dictionary folder is in play, ask:

> "Do you want to align **in priority onto this data dictionary**, and fall back
> to the full OMOP vocabulary only when no concept-set target fits? I can also
> work **category by category** (Ventilation, Vital signs, Drug…) so you review
> one clinical area at a time."

## Two iteration directions — source-first vs dictionary-first

Once the priority mode is on, the mapping can be driven in **two directions**.
They resolve the *same* target (dictionary first, OMOP fallback) and produce the
*same* output schema — only the **loop variable** and the **presentation**
differ. Pick one per session; the orchestrator asks (Step 2e) and passes the
choice through.

- **Source-first (default).** Loop over `source_concepts`. For each source
  concept, find its best target (dictionary candidate → dictionary direct search
  → OMOP fallback → no-match). This is the classic flow — it guarantees full
  coverage of the **source terminology**: every local code is looked at, whether
  or not the dictionary has a home for it. Best when the goal is "map all of my
  hospital terminology".

- **Dictionary-first (new).** Loop over `dict_targets`, **one category at a
  time**. For each dictionary target, pull the source concepts that align onto
  it and align them. This guarantees full coverage of the **dictionary**: every
  concept set gets filled in turn, so you never lose track of which sets are
  still empty. Best when the goal is "fill my concept sets fast, without getting
  lost". Sources with no dictionary home are **not** mapped here — they are
  listed at the end for a later source-first pass.

The four-branch resolution order below (Mapping Notes authority, dictionary →
OMOP → no-match) applies to **both** directions. Dictionary-first only changes
*which* concepts you iterate over and *how* you present them (grouped by target
instead of by source).

### Dictionary-first execution

1. **Iterate `dict_targets` for the active category**, grouped by concept set
   (`concept_set_uid` / `set_name`). Process one set fully before the next so a
   set is either "done" or "not started", never half-reviewed.

2. **For each dictionary target concept, collect its source candidates.** Query
   the restricted `similarity-scores.parquet` (already filtered to
   `concept_id ∈ dict_targets`) for rows whose `concept_id` is this target and
   whose `semantic/biolord ≥ threshold` (default 0.5). These are the source
   concepts that *might* belong to this set.

3. **Read the set's `longDescription` / Mapping Notes** (as always — see below)
   before deciding. The notes tell you what genuinely belongs to the set and
   what is out-of-scope.

4. **Align every source that genuinely fits — N sources → 1 target.** A concept
   set legitimately receives **multiple** source concepts (e.g. several local
   codes all meaning "heart rate" all map onto the same set's canonical
   concept). Emit one suggestion row per aligning source; they share the same
   `concept_id` but differ on `source_concept_code`, so the parquet uniqueness
   key `(source_vocabulary_id, source_concept_code, concept_id, method)` stays
   distinct — no schema change. Do **not** keep only the single best source.

5. **Present grouped by target**, not by source:

   ```
   Concept set: <set_name> [<concept_set_uid>]  → target <concept_id> <concept_name>
     Aligned sources:
       <vocab>/<code> <name>   equiv=skos:<level>  biolord=0.88  <one-line note>
       <vocab>/<code> <name>   equiv=skos:<level>  biolord=0.81  <one-line note>
     No source candidate above threshold — set left empty this pass.
   ```

6. **End-of-category coverage report.** After each category, report:
   - concept sets **filled** (≥1 source aligned) vs **left empty** (no adequate
     source candidate),
   - the list of **source concepts not covered** by any dictionary target in
     this category. These are NOT mapped in dictionary-first mode — surface them
     so the user can run a later source-first pass over them.

## Folder layout — targets come from the RESOLVED sets, not the expression

The dictionary has two parallel folders, one file (`<id>.json`) per set in each:

- **`concept_sets/<id>.json`** — the OHDSI concept-set **expression** (a
  *definition*) plus all metadata + the `longDescription`. `expression.items[]`
  lists seed concepts with boolean flags:
  - `includeDescendants` — pull in all descendants via the hierarchy
  - `includeMapped` — pull in all concepts that "Maps to" this one
  - `isExcluded` — remove this concept (and its descendants when combined with
    `includeDescendants`)

  Seeds are often high-level **classification** concepts (e.g.
  `37036048 "Sodium | Blood"`, `standardConcept:"C"`) with
  `includeDescendants:true`. **Reading these `conceptId`s as targets is the
  trap** — they are classification nodes, not the measurable standard concepts.

- **`concept_sets_resolved/<id>.json`** — the expression **evaluated** against
  the vocabulary: the concrete standard targets under `resolvedConcepts[]`
  (`conceptId`, `conceptName`, `vocabularyId`, `standardConcept`), e.g. the
  canonical `3019550 Sodium [Moles/volume] in Serum or Plasma`.

## Orchestrator role — prepare inputs and hand off

The orchestrator only **prepares inputs**; all target selection happens in
`/concept-mapping-ai`.

1. **Build `dict_targets` from the resolved sets.** Build
   `dict_targets(concept_id, concept_set_uid, source_repo, category,
   subcategory, set_name)` from `concept_sets_resolved/<id>.json` →
   `resolvedConcepts[]` (keep `standardConcept:"S"`), joined to metadata
   (`metadata.uniqueId`, `metadata.sourceRepo`,
   `metadata.translations.<lang>.category`/`subcategory`, set name) in the
   matching `concept_sets/<id>.json`. **Do not read targets from
   `expression.items[]`.** The same `concept_id` can belong to several sets —
   keep all links.
2. **Category by category** — process one `category` at a time (user picks the
   order; default: whatever they name first) so each review stays clinically
   coherent.
3. **Invert the direction and build the shortlist** — frame it as "for each
   dictionary target in this category, which source concepts align onto it?".
   Restrict the pre-computed `similarity-scores.parquet` (biolord +
   jaro-winkler) to `concept_id ∈ dict_targets`, keep source candidates above a
   threshold (default `semantic/biolord ≥ 0.5`), pass those candidate pairs to
   the sub-skill.

Hand off to `/concept-mapping-ai` with: the `dict_targets` table, **the
dictionary folder path** (so it can read each set's `longDescription`), the
active `category`, and the candidate pairs.

## Sub-skill role — target selection

**First, read the set's `longDescription` — it is the mapping authority
(MANDATORY when present).** For each candidate dictionary set, open
`concept_sets/<id>.json` and read `metadata.translations.<lang>.longDescription`
(Markdown). Its `## Mapping Notes` section names the **default target concept**
for the set, gives **conditional rules** (specimen/site/method/setting-vs-
measured), and lists **excluded / out-of-scope** concepts. You MUST follow it:

- Pick the **named default concept** unless the source's own `metadata_json`
  documents a specificity the notes map to a named variant (e.g. blood-gas
  analyser → arterial specimen; heart rate explicitly from pulse oximetry → the
  by-oximetry LOINC).
- **Never** choose a concept the notes list as excluded/out-of-scope, even if its
  biolord/jaro-winkler score is high — the longDescription **overrides** the
  similarity ranking.
- When a set has no Mapping Notes, use clinical judgement over its
  `resolvedConcepts`.

Then resolve the target in this order and stop at the first that genuinely fits:

1. **Dictionary candidate** — among the pre-computed candidates, prefer any whose
   `concept_id` is in `dict_targets` for the active category, **as directed by
   the set's Mapping Notes**. A high `semantic/biolord` score is a lead, not a
   decision; the Mapping Notes' default concept wins over a higher-scoring
   excluded one.
2. **Dictionary by direct search** — if no pre-computed candidate fits, search
   `dict_targets` (join to `concept`/`concept_synonym`) directly by the source
   name/synonyms. A terse or abbreviated source label (`VT`, `PEP`, `FR`, `FiO2`)
   often scores below the similarity threshold yet has an exact dictionary
   target — expand the abbreviation and look for it. Confirm against the Mapping
   Notes.
3. **Full OMOP fallback** — only if the dictionary has no adequate target (or its
   Mapping Notes mark the only plausible target as out-of-scope), search the
   whole `concept` table (standard + valid) as usual. This is expected and
   correct: the dictionary is curated and will not cover every source concept.
4. **`no-match`** — if neither the dictionary nor OMOP has an adequate target,
   return no match with a short reason (candidate for a future custom dictionary
   concept).

## Stamping

Record which branch fired:

- **Dictionary target (branches 1–2)** — stamp the suggestion with that set's
  `concept_set_uid` and `concept_set_source_repo` from `dict_targets`.
- **Plain OMOP target (branch 3)** — leave both null and note "outside the
  dictionary" in the `comment`.

Linkr matches `concept_set_uid` against `ConceptSet.uniqueId` to open the
concept-set sidebar, and uses `concept_set_source_repo` to offer "import this
dictionary" when the set is absent locally. See the `similarity-scores.parquet`
schema in `omop-duckdb-reference.md`.
