# Precomputed suggestions and semantic search

Syntactic and semantic scores give every source concept a ranked shortlist of
OMOP candidates before you look at it. Linkr computes them itself, on the
server, as background jobs. You can see what is set up, start a computation,
and search the vocabulary by meaning, all through MCP tools. Read this when the
user asks for precomputed suggestions, or when the word search keeps missing.

## What exists in the workspace

`list_suggestion_engines` (`mapping_project_id`) reports three things:

- **The embeddings runtime.** It is needed for anything semantic and not for
  syntactic scores.
- **The models.** These are sentence-transformers weights, e.g.
  BioLORD-2023-M.
- **The embedding configurations.** Each one is a model, a text template and a
  target scope (standard / valid, domains, vocabularies). Each writes its scores
  under the method `semantic/<slug>` and has an index per vocabulary, which is
  either built, out of date (the vocabulary was re-imported since) or not built.

Installing the runtime, downloading a model and creating configurations are
the user's decision: gigabytes, and shared by the whole workspace. When one is
missing, tell the user where it is done in Linkr: mapping editor › Suggestions
panel › Manage suggestions › Compute › Models and configurations. There, one click installs BioLORD-2023-M
with a configuration over the non-drug standard concepts.

## Semantic search while mapping

`semantic_search_vocabulary` encodes texts with a configuration's model and
returns the closest concepts of its index, with their similarity (cosine,
0–1). It finds what `search_vocabulary` misses: synonyms, paraphrases, a
French label translated loosely.

- **Batch the texts.** Send up to 50 per call, e.g. one per source concept of
  the batch: each call loads the model, which takes a few seconds.
- **Write the texts in English, as a clinician would.** Add the specimen or
  the unit when it decides between targets (`potassium [moles/volume] in
  serum`).
- **Narrow the targets** with `domains` / `vocabularies` when the domain is
  known. The search only covers what the configuration encoded.
- **A similarity is not an equivalence.** Inspect the finalists with
  `get_vocabulary_concept` and judge them with `omop-reference.md` as usual.

## Computing a project's scores

`compute_suggestion_scores` starts a job that scores every source concept of
the project:

| Method | Needs | Cost |
|---|---|---|
| `syntactic/jaro-winkler` | nothing | minutes |
| `syntactic/token-sort` | nothing | minutes |
| `syntactic/ngram-idf` | nothing | about an hour of CPU unfiltered |
| `semantic/<slug>` (`config`) | runtime + built index | minutes to an hour |

- **Ask the user before starting one**, and say how long it may take. Then
  follow it with `get_job_status` and `wait_seconds: 50`: each call waits for
  the job to end, up to 50 s. Never call it in a quick loop without
  `wait_seconds`. The scores reach the Suggestions panel once it is done.
- **Each method computed replaces that method's rows in the project.** With
  `only_missing`, it only adds the concepts it has not scored yet. AI
  suggestions (`ai/…`) are never touched.
- **Always filter the targets** (`domains`, `vocabularies`) to what is being
  mapped. The Drug domain alone is about 2 million standard concepts. The
  filters narrow the syntactic methods too: lab tests → `vocabularies:
  ["LOINC"]`, or a string match also ranks unrelated vocabularies (cancer
  registry variables, …) among the candidates.
- After the job ends, `list_source_concepts` with `with_suggestions` and
  `get_source_concept` show the new candidates. Do not read the batch while
  the job runs: you would read it twice.

`build_embedding_index` (`config`) encodes the vocabularies a configuration's
index lacks or has out of date. It takes about an hour on a CPU for the
non-drug standard concepts. Start it only when the user asks for it.

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
