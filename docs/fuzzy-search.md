# Fuzzy Search — Linkr Canonical Rules

Any user-facing text search that needs typo/accent tolerance must use `buildFuzzySearchSql` from `apps/web/src/lib/fuzzy-search.ts`. Do not hand-roll new ranking logic — extend the helper instead.

The helper emits a SQL predicate + a ranking expression for DuckDB; the caller composes them into its own query.

## Normalisation

Every comparand (column value AND query) is run through `strip_accents(LOWER(...))` before matching — `é/e`, `É/e`, `ç/c` etc. are treated as equal. **Do not add accent stripping at the call site** — the helper already handles it.

## Ranking Tiers (lower = better match)

| Tier | Match type |
|------|-----------|
| `0` | Exact numeric id (`idColumn`) |
| `1` | Exact code (folded equality, `codeColumn`) |
| `2` | Exact name (folded equality, `nameColumn`) |
| `3` | Prefix (name starts with full term, folded) |
| `4` | Substring (every space-separated word appears in name OR code) |
| `5` | Jaro-Winkler ≥ 0.75 (whole-string, folded name OR code) |

Within a tier: `jaro_winkler_similarity DESC`.

## Why Whole-String JW (not per-token)

Per-token JW (matching individual words against individual words) produced bad false positives — e.g. "réa" matching "créatinine". Whole-string JW is more discriminating and tolerates a low threshold (0.75) safely. The design philosophy is high recall: show every plausibly relevant row, let the higher tiers (exact/prefix/substring) keep the best hits at the top.

## Where It's Used

- Source-concept search bar in `MappingEditorTab` → `buildFileSourceConceptsQuery` (name, code or id)
- OHDSI target/browse search → `buildStandardConceptSearchQuery`, `buildStandardConceptSearchCountQuery`
- The concept lists' search field (`_searchFuzzy`: project Concepts page, a database's Concepts tab, the concept pickers) → `concept-queries.ts`

## Column filter on a label (`buildLabelFilterSql`)

A datatable's Name column filter runs on every keystroke (debounced), so it does not rank: every word must appear, in any order, folded like the rest. Only when **no** row contains them does it fall back on Jaro-Winkler ≥ `JW_FILTER_THRESHOLD` (0.85, stricter than the ranked search: a typo, not a loose neighbour) against the whole term — `NOT EXISTS (… words …)`, which DuckDB evaluates once. Measured on 2 M concepts: 50–160 ms, as fast as the `ILIKE` it replaced, which ignored accents.

If you add a new fuzzy search anywhere in the app, route it through this helper so the UX stays consistent.
