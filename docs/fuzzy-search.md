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

A datatable's Name column filter runs on every keystroke (debounced), so it does not rank: every word must appear, in any order, folded like the rest, and taken literally (`contains(…)`, not `LIKE`: a typed `%` or `_` is a character, as in the in-memory `labelMatcher`). Only when **no** row contains them does it fall back on Jaro-Winkler ≥ `JW_FILTER_THRESHOLD` (0.85, stricter than the ranked search: a typo, not a loose neighbour) against the whole term — `NOT EXISTS (… words …)`, which DuckDB evaluates once.

- **What the EXISTS looks at.** The `from` the caller passes, without the caller's other filters: a term that only matches rows another column filter (vocabulary, domain…) hides still counts as "something matches", so no typo fallback — the list is then empty rather than showing near misses. On a concept list with several dictionaries, `from` is the union of the active dictionaries' labels, so either all of them filter exactly or all of them fall back.
- **Cost.** Measured on 2 M concepts: 50–160 ms when something matches (the EXISTS stops at the first hit), as fast as the `ILIKE` it replaced, which ignored accents. A term nothing contains costs two scans: the EXISTS reads all of `from`, then the Jaro-Winkler pass reads it again.
- **Server twin.** The mapping projects' global summary filters its source/target name columns server-side with `label_filter_sql` (`apps/api/app/services/data/global_table_service.py`), which emits the same SQL text; `apps/web/src/lib/label-filter.fixture.json` holds the shared cases, and `apps/api/tests/test_label_filter.py` runs them on DuckDB.

## Strict matching — a list read straight from a remote database

Jaro-Winkler and `strip_accents` exist only in DuckDB. A remote database (Doris…) cannot run them, so a fuzzy predicate sent to it makes Linkr read the whole dictionary through the connection and filter it itself — tens of seconds on millions of concepts. The concept lists therefore match **strictly** whenever they read the database itself, i.e. in server mode without the concepts cache (not counted yet, or a dictionary that holds its own counts and so never gets one): `buildStrictSearchSql` (toolbar) and `buildStrictLabelFilterSql` (Name column), with `lowerLikeSql` for the code and id filters. Every word must appear as typed, case aside — `LOWER(col) LIKE '%word%'`, which the database runs itself; no accent folding, no typo fallback, and a typed `%` or `_` is a wildcard. Ranking: exact id, exact name or code, name prefix, the rest. A banner on the list says so. Once the cache exists, the lists read it with DuckDB and the fuzzy rules above apply again.

If you add a new fuzzy search anywhere in the app, route it through this helper so the UX stays consistent.
