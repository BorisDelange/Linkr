# Semantic search and precomputed suggestions

Semantic search is your main way to find candidates: it matches a source
concept with OMOP concepts by meaning, where a word search needs the exact
words. Precomputed suggestions are the same idea run ahead of time by the user,
over every source concept of the project. Read this before the first batch.

## What exists in the workspace

`list_suggestion_engines` (`mapping_project_id`) reports:

- **The embeddings runtime** — needed for anything semantic.
- **The models** — sentence-transformers weights, e.g. BioLORD-2023-M.
- **The embedding configurations** — each is a model, a text template and a
  target scope (standard / valid, domains, vocabularies, concept classes), with
  an index per vocabulary: built, out of date (the vocabulary was re-imported
  since; it still answers) or not built. A search only covers what its
  configuration's index holds.

Installing the runtime, downloading a model, creating a configuration, building
its index and computing a project's scores are the user's, in Linkr: gigabytes
and hours, shared by the whole workspace. When one is missing, say what it
would bring and where it is done (mapping editor › Suggestions panel › Manage
suggestions › Compute, and its Models and configurations button for the
engines; one click there installs BioLORD-2023-M with a configuration over
every standard concept). Never start it yourself.

## Semantic search while mapping

`semantic_search_vocabulary` encodes texts with a configuration's model and
returns the closest concepts of its index, with their similarity (cosine,
0–1).

- **One call per batch.** Send one text per source concept, up to 50 per
  call: each call loads the model, which takes a few seconds.
- **Write the texts in English, as a clinician would.** Add what decides
  between targets: the specimen or the unit (`potassium [moles/volume] in
  serum`); for a drug, RxNorm's own wording (`acetaminophen 500 MG Oral
  Tablet`).
- **Narrow the scope** to what the source can be: `domains`, `vocabularies`,
  `concept_classes`. Lab tests → `vocabularies: ["LOINC"]`; drugs →
  `domains: ["Drug"]` with the classes of the level you target (see
  `drugs.md`). Unfiltered, a string or meaning match also ranks unrelated
  vocabularies among the candidates.
- **A similarity is not an equivalence.** Inspect the finalists with
  `get_vocabulary_concept` and judge them with `omop-reference.md` as usual.
- **Several configurations with an index**: name one with `config` (its slug).
  The filters narrow within that configuration's index: repeating its own
  scope is harmless, a filter outside it returns nothing.

## Precomputed suggestions

When the user has computed them, `get_source_concept` lists each concept's
candidates by method (`semantic/<slug>`, `syntactic/jaro-winkler`…) with their
names and scores, and `list_source_concepts` with `with_suggestions` finds the
concepts that have some. They are leads, never decisions. A computation still
running only shows its candidates once it ends; it can be paused and resumed
in Linkr, and what it finished is readable at once.

## Scores file schema

The scores live in one file per project, which Linkr keeps on the server:

| Column | Type | Content |
|---|---|---|
| `source_vocabulary_id` | string | source vocabulary |
| `source_concept_code` | string | source code |
| `concept_id` | int64 | OMOP target |
| `method` | string | `syntactic/…`, `semantic/<slug>`, `ai/<model>` |
| `score` | float | 0–1 |
| `equivalence` | string | SKOS; always `skos:exactMatch` for syntactic and semantic rows |
| `comment` | string, null | justification (AI rows) |
| `created_at` | string | ISO 8601 |
| `concept_set_uid` | string, null | data-dictionary concept set a row was aligned to |
| `concept_set_source_repo` | string, null | that dictionary's repository |

Key: `(source_vocabulary_id, source_concept_code, concept_id, method)`.
