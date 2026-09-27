# Data catalog — crossing model & Publish (2026-09-27)

Branch `feature/data-catalog-ui`, worktree `../linkr-data-catalog-ui`. Implementation complete, waiting for
the user's manual test.

## What was built
- **Model**: a catalog has `variables` (concept, period, service, age, sex — each with its parameters) and
  `crossings` (1–3 variable ids). Every enabled variable's 1-way marginal is computed too. Legacy catalogs
  (dimensions + period table) are converted on load, on import and by the alembic migration `b7c1d9e3f5a2`.
- **Engine**: `lib/duckdb/catalog-queries.ts` (reads the `linkr_*` class relations), `catalog-compute.ts`,
  `catalog-runner.ts` (resumable per unit), `lib/data-catalog/{config,suppression,publish}.ts`.
- **Anonymisation**: primary suppression below the threshold + secondary suppression (a group whose total is
  published cannot hold a single masked cell). Published outputs never carry a masked cell's numbers.
- **App UI**: Configuration (variables, crossings with yield estimates), Data (pivot per crossing, masks
  shown), Anonymization (impact from the real masks), Publish (inline preview, GitLab/GitHub Pages).
- **Published page** (`lib/dcat-ap/catalog-page.js`): Explore tab — display one or two variables, filter
  them (period slider or calendar, modality picks, concept search), narrow the others to one value; charts
  depend on the display (trends, heatmap, pyramid, stacked/100 % bars, pies only where modalities partition
  the whole) + table + CSV. Never sums cells: distinct patients do not add up across periods, ages, units.
- **Files**: `catalog.html`, `concepts.csv`, `crossings/<id>.csv` (empty counts + status for masked cells),
  `metadata.jsonld` (one analytics distribution per file).

## Left
- User documentation on linkr-website — only once the user has tested and asks for it.

## Gotchas
- Never pass `en.json`'s literal type to generic helpers (`reduce`, `it.each`): tsc took ~50 min.
- In this worktree run pytest with `PYTHONPATH=.`: the copied venv otherwise imports the main checkout's app.
