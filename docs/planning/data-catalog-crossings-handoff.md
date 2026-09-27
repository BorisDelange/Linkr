# Data catalog — crossing model & Publish (2026-09-27)

Branch `feature/data-catalog-ui`, worktree `../linkr-data-catalog-ui`. Implementation complete, waiting for
the user's manual test.

## What was built
- **Model**: a catalog has `variables` (concept, period, service, age, sex — each with its parameters) and
  `crossings` (1–3 variable ids). Every enabled variable's 1-way marginal is computed too. Legacy catalogs
  (dimensions + period table) are converted on load, on import and by the alembic migration `b7c1d9e3f5a2`.
- **Engine**: `lib/duckdb/catalog-queries.ts` (reads the `linkr_*` class relations), `catalog-compute.ts`,
  `catalog-runner.ts`, `lib/data-catalog/{config,suppression,publish}.ts`. Built for very large warehouses:
  - a run is steps (sizing → concept counts → totals → rankings → crossings), each a list of one-query units;
    every unit adds into the run state, the cache holds exactly the units done, a resume carries on from there;
  - above `SLICE_EVENT_ROWS` event rows the warehouse is counted in patient-id ranges (quantiles), since
    patients, stays and records all add up over disjoint patients;
  - Pause and the yield estimate's Stop interrupt the query in flight: `queryDataSource(..., { signal })`
    (DuckDB-WASM `send` + `cancelSent`; server `POST /data-sources/{id}/query/cancel` → `con.interrupt()`);
  - `allRows` lifts the server's 10,000-row cap (up to 2M) — crossings and concept lists are larger.
- **Anonymisation**: primary suppression below the threshold + secondary suppression (a group whose total is
  published cannot hold a single masked cell). Published outputs never carry a masked cell's numbers.
- **One explorer, two hosts**: `lib/dcat-ap/catalog-explore.js` (ES module, ES5 inside) decides the charts,
  key figures and table for a picked crossing and draws the SVG charts. The published page inlines it with
  `export` stripped (`catalog-page.js` is the page's glue); the app's Data tab imports it (texts from
  `data_catalog.xp.*`, masked values revealed struck through). The reader picks a crossing (1–3 variables)
  and filters each variable; a variable filtered to one value becomes context; a 3-variable crossing is read
  one value of one variable at a time. Never sums cells.
- **App UI**: Configuration (coloured variables, crossings, stoppable yield estimate, run steps via
  `RunSteps`), Data (the explorer), Anonymization (impact, explanations behind ⓘ), Publish (Preview | Export).
- **Published page**: title in the header, Explore / Metadata / Schema / Info, generation line in the footer.
- **Files**: `catalog.html`, `concepts.csv`, `crossings/<id>.csv` (empty counts + status for masked cells),
  `metadata.jsonld` (one analytics distribution per file).

## Left
- User documentation on linkr-website — only once the user has tested and asks for it.

## Gotchas
- Never pass `en.json`'s literal type to generic helpers (`reduce`, `it.each`): tsc took ~50 min.
- In this worktree run pytest with `PYTHONPATH=.`: the copied venv otherwise imports the main checkout's app.
