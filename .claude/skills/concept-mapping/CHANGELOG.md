# Changelog — concept-mapping skill

Semantic versioning: `MAJOR.MINOR.PATCH`.
- **MAJOR** — breaking change to how the skill is invoked, its inputs, or its outputs (parquet/mappings schema, config keys).
- **MINOR** — new capability or mapping procedure, backward-compatible.
- **PATCH** — clarifications, prompt wording, bug fixes with no behavioural change.

The `version:` field in `SKILL.md` frontmatter must match the top entry here.
Cite the skill in publications as **"Linkr concept-mapping skill v\<version\>"**.

## 1.0.0 — 2026-07-21

First versioned release. Consolidates the previous three-skill layout
(`concept-mapping` orchestrator + `concept-mapping-ai` + `concept-mapping-drug`
sub-skills) into a single versioned skill.

- **Merged the three skills into one.** `concept-mapping-ai` and
  `concept-mapping-drug` are no longer separate skills; their procedures now live
  in `references/mapping-ai.md` and `references/mapping-drug.md`, loaded on demand
  by the single `concept-mapping` skill based on the batch's OMOP domain. No more
  cross-skill routing.
- **Introduced skill versioning** (this changelog + the `version:` frontmatter
  field) so a publication can cite the exact skill version used.
- Added a step to write `similarity-scores.parquet` and `source_embeddings.parquet`
  (+ `source-concepts-normalized.csv`) into the mapping-project repo's `.gitignore`
  when the project is a git repo, so generated artifacts are never versioned.
