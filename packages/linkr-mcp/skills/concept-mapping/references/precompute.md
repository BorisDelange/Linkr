# Precomputing suggestion scores

Syntactic and semantic scores give every source concept a ranked shortlist of
OMOP candidates before any agent looks at it. They are computed **outside the
chat**, by the user in a terminal (or by an agent that has a shell), then loaded
into the mapping project in Linkr. Read this when the user asks for them.

Two scripts, in this skill's `scripts/` folder. Each one's `--help` and module
docstring hold the full flag list, resume behaviour and FAISS cache details.

| Script | How often | Produces |
|---|---|---|
| `embed_concepts.py` | once per vocabulary release, shared by all projects | `concept_embeddings.parquet` next to `CONCEPT.parquet` (BioLORD embeddings of OMOP concepts) |
| `compute_scores.py` | once per project and target scope | `similarity-scores.parquet` (syntactic + semantic scores per source concept) |

Without `concept_embeddings.parquet`, `compute_scores.py` computes only the
syntactic methods. Defaults are right for the usual case (`syntactic/jaro-winkler`
+ `semantic/biolord`); do not add `syntactic/ngram-idf` unless asked — it indexes
about 4 million concepts (around an hour of CPU).

Dependencies: `pip install rapidfuzz pandas pyarrow numpy duckdb`, plus
`sentence-transformers faiss-cpu` for the semantic step.

## Inputs

- **OMOP vocabulary** — the ATHENA files (`CONCEPT.parquet` or `.csv`).
- **Source concepts** — a CSV with three columns: `terminology`,
  `concept_code`, `concept_name`. Get it from Linkr (export the mapping project,
  or download its source file), then rename columns if needed:

  | Needed | Usual names |
  |---|---|
  | `terminology` | terminology, vocabulary_id, vocab, source_vocab |
  | `concept_code` | concept_code, code, source_code, local_code |
  | `concept_name` | concept_name, label, name, description |

  Keep the other columns out of this file: the scripts read only these three.

## Memory — always filter the targets

The semantic step builds an index over the **target** concepts. Unfiltered,
that is about 4 million vectors and 25 GB at peak: enough to kill a laptop.
Always pass `--only-standard --only-valid` and a `--domain` (and/or
`--vocabulary`) matching what is being mapped.

The Drug domain alone (RxNorm, about 2 million standard concepts) is the main
cost: leave it out unless mapping medications, and then run it as its own pass.
Non-drug standard valid targets (about 500,000) peak around 3 GB.

## Running

Both scripts run for minutes to hours and resume where they stopped (an
interruption loses at most one flush). Give the user the exact command to paste
in their own terminal, where they can watch memory and stop it with `Ctrl-C`.
Do not run `compute_scores.py` unattended in the background: a first semantic
build uses several GB and cannot be throttled.

```bash
python scripts/compute_scores.py \
  --source source-concepts.csv \
  --concept /path/to/vocabulary/CONCEPT.parquet \
  --embeddings /path/to/vocabulary/concept_embeddings.parquet \
  --only-standard --only-valid --domain Measurement Observation
```

## Loading into Linkr

In the mapping editor: Suggestions → load scores file. **Loading replaces the
project's scores file**, including AI suggestions agents left through the MCP.
To keep them, download the current scores file from Linkr first and pass it as
`--output`: the script adds its rows to the existing file and keeps the rest.

## Scores file schema

| Column | Type | Content |
|---|---|---|
| `source_vocabulary_id` | string | source vocabulary |
| `source_concept_code` | string | source code |
| `concept_id` | int64 | OMOP target |
| `method` | string | `syntactic/…`, `semantic/biolord`, `ai/<model>` |
| `score` | float | 0–1 |
| `equivalence` | string | SKOS; always `skos:exactMatch` for syntactic and semantic rows |
| `comment` | string, null | justification (AI rows) |
| `created_at` | string | ISO 8601 |
| `concept_set_uid` | string, null | data-dictionary concept set a row was aligned to |
| `concept_set_source_repo` | string, null | that dictionary's repository |

Key: `(source_vocabulary_id, source_concept_code, concept_id, method)`. Rows
are only ever added: an existing key is kept, never overwritten.
