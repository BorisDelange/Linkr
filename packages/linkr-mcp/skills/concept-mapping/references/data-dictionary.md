# Aligning onto a data dictionary

Read this when the user wants source concepts aligned **onto a curated data
dictionary** first, with the full OMOP vocabulary only as a fallback. In Linkr,
a data dictionary is a set of **concept sets** imported into the workspace (the
INDICATE Data Dictionary is one; any OHDSI concept-set collection works). Never
assume a dictionary: the user names it, or mentions concept sets.

## Find the dictionary

- `list_concept_sets` with the mapping project's `workspace_id` (from
  `get_mapping_project`), filtered with `search` by category or name.
- `get_concept_set` on each set you use. It gives:
  - the **expression** — seed concepts with descendant / mapped / excluded
    flags. Seeds are often *classification* concepts (e.g. `Sodium | Blood`,
    standard_concept C): **they are not targets**;
  - the **resolved concepts** — the concrete standard concepts the expression
    stands for. **Targets come from these**;
  - the **long description**, whose *Mapping Notes* section is the authority
    for mapping onto the set (see below);
  - its `uniqueId` and source repository.
- `search_vocabulary` with `concept_set_id` searches only a set's resolved
  concepts, by name; with an empty `query` it lists them.

Sets not yet resolved in Linkr (the tool says so) only know their seeds: ask the
user to resolve them in Linkr, or search the seeds' descendants yourself with
`get_vocabulary_concept`.

## Ask the direction

Both directions resolve the same targets and write the same suggestions; they
differ in what you loop over, and so in what gets fully covered:

> "Two ways to go:
>
> **1. Source-first (default).** I go through **your source concepts** and find
> each one's best target — a concept set of the dictionary when one fits,
> otherwise the whole OMOP vocabulary. Every one of *your codes* gets looked at.
> Best for *'map all my local terminology'*.
>
> **2. Dictionary-first.** I go through **the dictionary's concept sets**,
> category by category, and for each one gather *all* the source concepts that
> belong to it. Every *concept set* gets filled in turn, and you always know
> which are still empty. A set can receive several sources (several local
> 'heart rate' codes). Source concepts that fit no set are not mapped here; I
> list them at the end for a source-first pass.
>
> Which one?"

Work **one category at a time** in either direction, so each review stays
clinically coherent.

## The Mapping Notes are the authority

Before choosing a target in a set, read its long description. Its
*Mapping Notes* name the **default target**, give **conditional rules**
(specimen, site, method, measured vs set value) and list **excluded** concepts.

- Pick the named default, unless the source's metadata documents a
  specificity the notes map to a named variant (blood-gas analyser → arterial
  specimen; heart rate from pulse oximetry → the oximetry LOINC).
- **Never** pick a concept the notes exclude, whatever its score.
- No Mapping Notes: use clinical judgement over the resolved concepts.

## Resolution order (both directions)

Stop at the first that genuinely fits:

1. **A dictionary candidate** among the suggestions — a target that belongs to a
   set of the active category, as the Mapping Notes direct.
2. **A dictionary target by search** — `search_vocabulary` with
   `concept_set_id`. Terse labels (`VT`, `PEP`, `FR`, `FiO2`) often score low
   yet have an exact target: expand the abbreviation and search.
3. **The full OMOP vocabulary** — when no set fits, or the notes exclude the
   only plausible target. Expected: a curated dictionary does not cover
   everything. Say "outside the dictionary" in the comment.
4. **No match** — report it with a short reason (a candidate for a future
   dictionary concept).

## Dictionary-first loop

1. Take the sets of the active category, one at a time; finish a set before the
   next.
2. List its resolved concepts (`search_vocabulary`, `concept_set_id`, empty
   query), read its Mapping Notes.
3. Find the source concepts that belong to it: first
   `find_sources_for_targets` with the set's `concept_set_id` (default
   `min_score` 0.5) — the sources precomputed scores already link to its
   concepts; then `list_source_concepts` with `search` on the set's clinical
   terms (in the source's language too) for terse labels that scored low.
   Check each with `get_source_concept`.
4. Suggest every source that genuinely fits — N sources → 1 target is normal.
5. Present by set:

   ```
   Concept set <name> → <concept_id> <target name>
     <vocabulary>/<code> <source name>  closeMatch 0.8  <short reason>
     <vocabulary>/<code> <source name>  exactMatch 0.9  <short reason>
   ```

   and name the sets left empty.
6. At the end of a category: sets filled vs empty, and the source concepts of
   the category no set covers.

## Writing

On `add_ai_suggestions`, pass `concept_set_id` for every target taken from a
set (resolution steps 1–2). Linkr stores the set's `uniqueId` with the
suggestion, links it to the set in the Suggestions panel, and counts it in the
*data dictionary* category. Leave it out for full-OMOP targets.
