# Data catalog — crossing model & Publish: handoff (WIP, 2026-09-27)

Branch `feature/data-catalog-ui`, worktree `../linkr-data-catalog-ui`. Last commit is a WIP: the
frontend does NOT typecheck yet (≈75 errors, all in the files listed under "To do").

## Done (in the WIP commit)
- **Engine** (by a subagent, reviewed): `types/catalog.ts` (variables + crossings + long-format
  `CatalogResultCache.crossings`, `modalities`, `labels`, `computedSteps`), `lib/data-catalog/config.ts`
  (defaults, canonical crossing ids, effective crossings, age labels, period range/trim, legacy
  conversion `normalizeCatalog`), `lib/data-catalog/suppression.ts` (primary + secondary suppression,
  `computeCrossingMasks`), `lib/duckdb/catalog-queries.ts` (crossing / estimate / service list /
  concept rank / totals SQL), `catalog-compute.ts` (plan, units, estimates cache), `catalog-runner.ts`
  (resumable per crossing unit), `catalog-store.ts` (legacy conversion on load), `CreateCatalogDialog`.
- **Publish** (by a subagent, reviewed): inline preview + `allow-downloads`, ZIP tooltip, summary strip
  removed, GitLab/GitHub Pages deployment (`lib/dcat-ap/pages-deployment.ts` + tests,
  `pages-site-files.ts`, `CatalogPagesCard.tsx`, `pagesDeployment` field in types / API model+schemas /
  linkr-format / entity-io / server export `_pages_site_files`, attachments owner `data-catalog-site`),
  i18n merged.

## To do
1. **Runner bug**: resuming inside a chunked concept crossing deletes earlier chunks' rows
   (`catalog-runner.ts`, `results.delete` over `plan.units.slice(offset)`): rewind `offset` to the first
   unit of that crossing before deleting.
2. **UI**: rewrite `CatalogConfigTab.tsx` (Variables card: period granularity, age brackets editor —
   keep `AgeBrackets`, sex, service level + grouping all / top N / manual groups with a searchable
   service→group table, concept level/columns/scope; Crossings card: triangular matrix for pairs +
   "add a 3-variable crossing" list; Estimate button → yield badges via `estimateCrossings`
   green ≥90 % / amber 60–90 / red <60, tooltip cells + patient share; compute card as today with
   `computedSteps`), `CatalogDataTab.tsx` (one sub-tab per crossing, pivot DataTable: first variable
   rows pinned, second variable columns, Total column, ALL pinned row, Patients/Stays/Records toggle,
   3-way modality selector, masks from `computeCrossingMasks`, secondary cells distinguishable,
   periods trimmed with `trimPeriods`; Concepts sub-tab unchanged), `CatalogAnonymizationTab.tsx`
   (impact from masks), `CatalogDetailPage.tsx` if needed.
3. **Exports**: `export-html.ts` overview charts from 1-way marginals + a Crossings tab using
   `createDataTable` (masked "< T"); replace `buildDimensionsCsv` by one CSV per crossing
   (`crossings/<id>.csv`), update `PUBLICATION_FILES` in `use-catalog-publish.ts` and
   `analyticsDistributions` in `jsonld.ts` (reads `cache.dimensions` today).
4. **Backend**: columns `variables` (JSON), `crossings` (JSON), `computed_steps` (int),
   `pages_deployment` (JSON) on `data_catalogs` + schemas (Create/Update/Response) + ONE alembic
   migration; server export `_portable_catalog` strips `computedSteps` (was `computedPeriods`);
   `entity-io.ts` same (line with `computedPeriods`).
5. **linkr-format**: `validate/records.ts` still validates `dimensions`; validate `variables`/`crossings`.
   Regenerate the data-catalog export goldens (no VERSION change).
6. **Tests**: update `catalog-queries.test.ts`, `catalog-compute.test.ts`; add tests for config
   (legacy conversion, periodRange, trimPeriods, effectiveCrossings), suppression, SQL builders.
   Validate the SQL on `/Users/borisdelange/Documents/linkr/_databases/dc61f7ca-…duckdb` (read-only).
7. Masked spelling: use "< T" everywhere (heatmaps show "<10").
8. Then: full `npm run test`, backend pytest, tell the user the run command
   (`cd "…/linkr-data-catalog-ui" && npm run dev:all`, http://localhost:3011).

## Gotcha found
Never pass `en.json`'s literal type to generic helpers (`reduce`, `it.each`): tsc took ~50 min.
Widen to `unknown` first (see `EN_BUNDLE` in export-html.ts).
