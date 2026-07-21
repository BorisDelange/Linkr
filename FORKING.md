# Forking Linkr to use the Claude Code skills

This guide is for users who want to fork Linkr in order to run the Claude Code skills bundled in `.claude/skills/` (concept mapping, plugin scaffolding, etc.) against their own local data — OHDSI vocabularies, mapping projects, model caches.

The skills read a small local config file (`config.local.json`) so paths only have to be set once, instead of being prompted at every session start.

> **Full user documentation:** [Concept mapping — Suggestions](https://linkr.interhop.org/docs/concept-mapping/suggestions/) on the Linkr website covers what the skill does, the suggestion pipeline (syntactic + semantic), and how mappings flow back into Linkr. The present file is the technical setup guide that complements it.

## 1. Clone the repository

```bash
git clone git@framagit.org:interhop/linkr/linkr.git
cd linkr
```

If you plan to contribute back, fork the project on Framagit first and clone your fork instead.

## 2. Install Claude Code

The skills run inside [Claude Code](https://claude.ai/code). Install the CLI or the VS Code extension and open the repo with it. The skills under `.claude/skills/` are auto-discovered.

## 3. Create your local config

```bash
cp config.local.example.json config.local.json
```

Edit `config.local.json` with absolute paths that exist on your machine:

```json
{
  "concept-mapping": {
    "vocab_dir":    "/path/to/ohdsi-vocabularies",
    "models_dir":   "/path/to/bert-models-cache",
    "projects_dir": "/path/to/mapping-projects"
  }
}
```

`config.local.json` is gitignored — it is machine-specific and must never be committed.

### What each path is for

| Key | Contents | How it is used |
|---|---|---|
| `vocab_dir` | Folder with the OHDSI vocabularies (`CONCEPT.parquet`, `CONCEPT_SYNONYM.parquet`, `CONCEPT_RELATIONSHIP.parquet`, `CONCEPT_ANCESTOR.parquet`). | DuckDB queries during mapping; embeddings are co-located here as `concept_embeddings.parquet`. |
| `models_dir` | Local cache for `sentence-transformers` models (BioLORD-2023-M ~440 MB). | Set as `TRANSFORMERS_CACHE` when running the precompute scripts so the model is downloaded once. |
| `projects_dir` | Folder containing one sub-folder per mapping project (each with `project.json`, `source-concepts.csv`, `mappings.json`, …). | The orchestrator derives `<projects_dir>/<project-name>/` as the working directory. |

## 4. Download the OHDSI vocabularies

The skills don't ship vocabularies. Download them from [Athena](https://athena.ohdsi.org/) (free account required) and convert the CSVs to Parquet for fast querying:

```bash
# Place the downloaded CSVs into vocab_dir, then:
duckdb -c "
  COPY (SELECT * FROM read_csv_auto('CONCEPT.csv',          sep='\t')) TO 'CONCEPT.parquet'           (FORMAT PARQUET, COMPRESSION ZSTD);
  COPY (SELECT * FROM read_csv_auto('CONCEPT_SYNONYM.csv',  sep='\t')) TO 'CONCEPT_SYNONYM.parquet'   (FORMAT PARQUET, COMPRESSION ZSTD);
  COPY (SELECT * FROM read_csv_auto('CONCEPT_RELATIONSHIP.csv', sep='\t')) TO 'CONCEPT_RELATIONSHIP.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);
  COPY (SELECT * FROM read_csv_auto('CONCEPT_ANCESTOR.csv', sep='\t')) TO 'CONCEPT_ANCESTOR.parquet'  (FORMAT PARQUET, COMPRESSION ZSTD);
"
```

## 5. Install the Python dependencies for the precompute scripts

The concept-mapping skill calls two Python scripts (`embed_concepts.py`, `compute_scores.py`) that compute similarity scores once per project. Install their dependencies:

```bash
pip install pandas pyarrow numpy rapidfuzz sentence-transformers
```

These are only needed for the precompute step — the rest of the skill uses DuckDB and Claude directly.

## 6. Generate concept embeddings (once per vocabulary release)

```bash
TRANSFORMERS_CACHE=<models_dir> python \
  .claude/skills/concept-mapping/scripts/embed_concepts.py \
  --concept <vocab_dir>/CONCEPT.parquet
```

On the first run, `sentence-transformers` automatically downloads the [BioLORD-2023-M](https://huggingface.co/FremyCompany/BioLORD-2023-M) model (~440 MB) from Hugging Face Hub into `<models_dir>` (or `~/.cache/huggingface/` if `TRANSFORMERS_CACHE` is unset). The model is public — no Hugging Face account needed. Subsequent runs read from the cache, no network required.

Output goes to `<vocab_dir>/concept_embeddings.parquet`. This is a multi-hour run on CPU for the full vocabulary (~4M concepts). The script writes incrementally and resumes safely on interruption.

## 7. Create a mapping project in Linkr and export it

Mapping projects are created and managed in Linkr itself — that is where you import the source dictionary, configure target vocabularies, review suggestions, and validate mappings. The skill operates on a snapshot exported from Linkr.

1. In Linkr, go to **Data Warehouse → Concept Mapping** and create a new project. Import your source concept dictionary (CSV with at least `terminology`, `concept_code`, `concept_name`).
2. When you want Claude to generate suggestions, **export the project** from Linkr — this produces a ZIP containing `project.json`, `source-concepts.csv`, and `mappings.json`.
3. Unzip it under `<projects_dir>` (or hand the ZIP directly to the skill):

   ```
   <projects_dir>/my-project/
   ├── project.json
   ├── source-concepts.csv
   └── mappings.json
   ```

4. Ask Claude to run the skill on the project folder or ZIP:

   > /concept-mapping `<projects_dir>/my-project`

   The skill reads `config.local.json`, finds the right paths, loads the project, runs the precompute scripts (Section 6 + `compute_scores.py`), and follows the domain-appropriate mapping procedure (clinical concepts or drugs) — all in one skill.

5. Once the skill has appended new mappings to `mappings.json`, import the updated file back into Linkr to continue review and validation there.

## 8. Optional: the review dashboard

After the first batch, the skill can launch a small static dashboard showing progress, computed methods, recent sessions, and file status. It reads `state.json` (written by the skill) and is served via `python -m http.server` from the project folder. Open `http://localhost:8765/review/` once running.

## Contributing back

Changes to the skills themselves (the files under `.claude/skills/`) are tracked in git — push them to a branch on your fork and open a merge request. Changes to `config.local.json` are never committed.
