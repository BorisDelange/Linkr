# Running the precomputation scripts

Read this only when you need **fresh suggestions** — i.e. when the user asks to
(re)compute scores, or `similarity-scores.parquet` is missing/stale. For simple
mapping of an existing batch, skip it.

Two scripts live in `.claude/skills/concept-mapping/scripts/`. **The exhaustive
flag list, resume semantics, and FAISS cache behaviour live in each script's
`--help` and module docstring — read those for the "how".** This file only holds
the operational judgement that is *not* in the code: when to run each, how to run
it (terminal vs Monitor), and the one memory pitfall that will OOM a laptop.

## When to run which

| Script | Cadence | Purpose |
|---|---|---|
| `embed_concepts.py` | once **per vocabulary release** (shared across all projects) | BioLORD embeddings for OMOP concepts → `<vocab_dir>/concept_embeddings.parquet` |
| `compute_scores.py` | once **per project** (per target scope) | syntactic + semantic scores for the project's source concepts → `<project_dir>/similarity-scores.parquet` |

`compute_scores.py` needs `concept_embeddings.parquet` to produce semantic
scores. If it is absent, only syntactic methods run.

See `python <script> --help` for every flag. Defaults are already correct for the
common case: `compute_scores.py` computes `syntactic/jaro-winkler` +
`semantic/biolord`. Do **not** add `syntactic/ngram-idf` unless the user asks —
it builds a bigram IDF index over ~4M concepts (~1h CPU).

## ⚠️ Memory — always pass target filters to compute_scores.py

The semantic step builds a FAISS index over the **target** OMOP concepts.
Unfiltered that is ~4M vectors (~12.5 GB matrix, ~25 GB+ peak during build —
enough to OOM-kill a laptop). **Always restrict the target set** with
`--only-standard --only-valid` plus a `--domain` (and/or `--vocabulary`) matched
to what you are mapping.

The single biggest driver is the **Drug domain (RxNorm ≈ 2M standard concepts on
its own)**. Exclude it unless you are specifically mapping medications — in which
case run Drug as its own pass. Non-Drug standard+valid targets total ≈ 500k
(~3 GB peak) and are safe.

(The FAISS index is cached on disk keyed by the target filter, so a rerun with
the same scope reloads instead of rescanning — details in the `compute_scores.py`
docstring. A different scope produces a distinct key, so a stale index is never
silently reused.)

## How to run — terminal vs Monitor

Both scripts are long-running (minutes to hours) and support resume. Before
launching, ask the user how they want to run it:

> "These scripts can take a long time. Two options:
>
> 1. **Run it yourself in a terminal (recommended)** — copy the command below,
>    paste it into your terminal. No extra token cost.
> 2. **I run it via Monitor** — I stream progress here, but every progress line
>    costs tokens (can be significant over hours)."

**Recommend option 1.** Print the exact command in a copy-paste block and stop.
When the user comes back and says it's done (or interrupted), verify the output
file exists and refresh `state.json` (`update_state.py`, see orchestrator Step 6).

Both are **resume-safe**: an interrupt loses at most one flush window. Never
launch `compute_scores.py` as a `run_in_background` task — a first, uncached
semantic build peaks at several GB and a background run cannot be RAM-throttled;
the user must be able to watch memory and `Ctrl-C`.

If the user insists on **option 2**, launch with `Monitor` + `persistent: true`
(no timeout, never `run_in_background`) and filter aggressively to keep token
cost down:

- `embed_concepts.py` (flush-only, cuts volume ~5×):
  ```
  \[flush\]|Done|Error|Traceback
  ```
- `compute_scores.py` (flush + index-build milestones only):
  ```
  \[flush\]|\[index-add\]|\[index\]|Done|Error|Traceback
  ```

## Where the output goes

- `embed_concepts.py` → `<vocab_dir>/concept_embeddings.parquet` (co-located with
  CONCEPT.parquet, shared across projects).
- `compute_scores.py` → `<project_dir>/similarity-scores.parquet` +
  `<project_dir>/source_embeddings.parquet`. The user loads the scores file in
  Linkr (Suggestions tab → "Load scores file"). Schema and resume/idempotency
  rules are in `omop-duckdb-reference.md`.
