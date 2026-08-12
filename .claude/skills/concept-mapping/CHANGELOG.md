# Changelog — concept-mapping skill

Semantic versioning: `MAJOR.MINOR.PATCH`.
- **MAJOR** — breaking change to how the skill is invoked, its inputs, or its outputs (parquet/mappings schema, config keys).
- **MINOR** — new capability or mapping procedure, backward-compatible.
- **PATCH** — clarifications, prompt wording, bug fixes with no behavioural change.

The `version:` field in `SKILL.md` frontmatter must match the top entry here.
Cite the skill in publications as **"Linkr concept-mapping skill v\<version\>"**.

## 1.0.2 — 2026-08-12

- **`project.json` stats are now refreshed after every `mappings.json` write.**
  The skill appended mappings without touching `project.json`, so a re-imported
  project kept displaying a stale `mappedCount`. New script
  `scripts/update_project_stats.py` recomputes the `stats` block, mirroring the
  app's own rule (`compute_project_stats` / `getStats`). Wired into `SKILL.md`
  Step 6, `mapping-ai.md` Step D and `mapping-drug.md` Step 7.

## 1.0.1 — 2026-07-21

Drug mapping (`references/mapping-drug.md`) reworked around a benchmark on the
French UCD gold set (287/300 expert-validated codes vs this project's
`similarity-scores.parquet`):

- **Candidate search now uses the pre-computed similarity scores as the primary
  source** (biolord first, jaro-winkler secondary), replacing the label-based
  ILIKE search. On the gold set biolord found the correct ingredient in 66.8% of
  cases at top-1 (77.3% at top-50) and 48.7% on brand-name codes where ILIKE
  collapsed to 9.7%; ILIKE found nothing the scores missed. Ingredient/ATC/RxNorm
  traversal is kept only as a **fallback** (scores absent or shortlist invalid).
- **Roles split explicitly**: scores *find* candidates (blind to strength),
  parsed ingredient/strength/form *validate and rank* them. A similarity score
  may never settle a strength.
- **Target the most granular standard concept** the source supports (branded
  level when a brand name is present) instead of always Clinical Drug; Step 1 now
  also parses the brand name. Accept RxNorm and RxNorm Extension.
- **Validation tightened**: strength strict (equal / mathematically equivalent,
  else flag — no approximation); dose form must match exactly (only lexical
  variants of the same form allowed), a different-but-related form is a
  `closeMatch` with the difference spelled out, never a silent exactMatch.

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
