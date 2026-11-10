# Server-owned runs, part 2: every long computation

[server-runs-plan.md](server-runs-plan.md) moved the database Concepts tab and the
mapping extraction to server-owned runs: the browser compiles, the server runs, the
page only reads; a reload, a closed tab or a server restart changes nothing. The
other long computations still have the page drive them, or follow a job only as long
as it stays open. This plan extends the same contract to all of them, in server
mode. Client-only (WASM) mode keeps its browser loops.

Decided 2026-11-08: every computation below, in this order; the data catalog by a
Python twin of its planning (the server runs it end to end, page open or not).

## 1. Inventory (server mode, after a reload)

| Computation | Today | Long on a large warehouse |
|---|---|---|
| Data catalog computation | each phase a query job, the page chains the phases: shows "paused", Resume re-attaches by hand | minutes – hours |
| ETL pipeline run | the page loops over scripts, each an `etl` job: the scripts after the one in flight never start | minutes – hours |
| ETL Quality tab | query jobs not remembered + 14 blocking requests: runs on unseen, the page starts over; `countConcepts`'s `catch {}` saves a cancelled count as "table absent" | minutes – an hour |
| Catalog size estimate | blocking requests, results in memory: lost | minutes – hours |
| Catalog disclosure audit | CPU in the page, saved at the end: lost | seconds – minutes |
| Cohort run and attrition, report figures | blocking requests: lost, the count saved only at the end | seconds – an hour |
| Databases page statistics, DQ runs | one remembered query job, re-followed after a reload | kept as is, A1 below moves the stats onto the generic kind |
| Embedding index, suggestion scores | server job found again by the page | kept |
| Vocabulary import, environment build, cohort freeze, derive | one server job, the page loses its own spinner (the jobs panel shows it) | follow-up, not here |

## 2. The framework, generalised (step 0)

- **`server_runs`** replaces `concept_runs`, by a migration that renames it (the first
  one is already applied on development instances). `kind` (`stats`, `extraction`, `etl`, `catalog`, `query_list`,
  `catalog_audit`), `scope_id` (the database, project, pipeline target, catalog,
  cohort…), `data_source_id` nullable. One active run per `(kind, scope_id)`.
- **`services/server_runs/`**: the shared part — `state.py` (single-flight, fencing,
  lease), `runs.py` (start/pause/resume/recover), `worker.py`, `watchdog.py`,
  a base executor (heartbeat, boundary, `_query` in the `heavy_query` lane, `_note`,
  `save`, stall handling) — and one module per kind (`concepts/`, `etl/`, `catalog/`,
  `query_list.py`, `catalog_audit.py`). A registry maps a kind to its spec model, its
  executor and its `authorize(db, user, scope, action)`.
- **Routes** `/server-runs/latest?kind&scopeId`, `POST /server-runs`,
  `/server-runs/{id}/pause|resume`, `/server-runs/{id}/results/{key}`. The concept
  routes go.
- **Web**: `use-server-run.ts` (the reader, generalised from `use-concept-run.ts`),
  `lib/api/server-runs.ts`.
- One heavy query at a time stays the rule: every executor queries through the
  `heavy_query` lane, so a catalog run and a statistics run on one database take turns.

## 3. ETL pipeline (step 1)

- **Server mode with a managed target** only (the `serverStreamTarget` gate); a
  non-managed target writes nothing and stays in the browser, `runOne` (a selection,
  a script in the editor) stays a one-shot `etl` job.
- **Spec** (`compileEtlRunSpec`): scripts in order with their SQL as written (a
  managed target attaches each role under its own name, so no prefix rewrite), the
  roles, skips, the mapping data as files of the run. **One run per target database**
  (one writer per DuckDB file).
- **Executor**: `run_script` extracted from `etl_jobs.start`, one script a step;
  checkpoint per script (a script is one DuckDB session). It owns the run history row
  (`EtlRunHistory`, id = run id).
- **Pause** cuts the statement in flight and marks the script `stopped`; resume runs it
  again from its start, as today. **Resume with edits**: the steps not yet done can be
  recompiled from the page.
- **After a server restart** a script cut in the middle has partial writes: the run
  stays `interrupted` and the page says which script will run again from its start,
  rather than re-run it unasked. (Exactly-once per script by a transaction wrap is to
  be measured first: DuckDB refuses one transaction writing two attached databases.)
- MCP `runPipeline` starts the run and polls it.

## 4. Data catalog computation (step 2) — Python twin

- **The page keeps building every SQL** (class relations included). The four values
  that depend on earlier results become comment tokens that `prepareQuerySql` leaves
  alone: patient slices `/*LINKR_RANGE:WHERE|AND:<col>*/`, bound picks, top services,
  the concept filter `/*LINKR_CONCEPT_IN:<dict>:<col>*/` (a dictionary without ids in
  a chunk gets `AND FALSE` instead of being cut out). `fillCatalogSql` fills them, in
  both modes, so both run the same SQL.
- **Python twins** (`server_runs/catalog/compute.py`, ~420 lines): `planSlices`,
  `baseUnits` and their row folding, `planCrossings`, `cacheFromState`/`stateFromCache`,
  `orderModalities`, `periodRange`, the filler. Ties break by code points on both sides
  (not `localeCompare`). `runCatalogComputation` becomes the executor.
- **Checkpoint = the results cache** (`work`, `completedSteps`), written with the
  catalog row in one fenced transaction (every 5 s, or longer for a large cache). The
  anonymization impact stays in the page (the Anonymization tab fills it when missing).
- **Twin fixture**: a DuckDB-WASM warehouse forcing slices, chunks, top-N ties, noise,
  periods; the browser writes the specs, units and caches
  (`src/lib/__fixtures__/catalog-runs/`), the server must store the same cache, also
  after a pause and a resume.
- `catalog-job-executor.ts` and the `work.job` handover go; the page runner stays for
  client-only mode; the MCP `compute_data_catalog` starts the run and polls it.

## 5. The generic `query_list` kind (step 3) and the ETL Quality tab

- **`query_list`**: a durable query job — `spec = {label, items: [{key, sql}], keepGoing,
  meta, sink?}`, each result written to `data_dir/server-runs/<run>/results/<key>.json`,
  `state.next` the checkpoint; local engines through the worker. **Sinks**: named
  Python hooks that store a finished result where it belongs, so a closed tab still
  lands it. `query-plan.ts`: one compile and one assemble for both modes.
- **Fix first**: `countConcepts`'s `catch {}` (a cancelled count saved as "absent").
- **ETL Quality**: the database statistics (shared with the Databases page, replacing
  its remembered jobs) and the concept comparison (mappings as a CTE semi-join, no
  id lists, no dependency between items); the page assembles a finished run once,
  stamped with its run id.

## 6. Catalog size estimate (step 4)

A mode of the catalog executor: rank, pick the top N (the twin of step 2), fill the
crossing templates, run each estimate; each lands in `stats_cache`
(`catalog-estimate`) as it comes, and the page reads that instead of its in-memory map.

## 7. Cohorts (step 5)

`query_list` runs: `cohort_run` (output, members, attrition steps; a sink writes the
count and attrition when the cohort still matches the run's definition and it is no
draft), `cohort_figures` (the report's query and flow). The store and `report-runs.ts`
derive their state from the run. Member ids in the run's files are deleted with the
run and the cohort.

## 8. Disclosure audit (step 6)

CPU only. **Benchmark first** CPython against V8 on a large generated catalog. Within
~10×: a Python port of `auditPublished` (~300 lines, twin fixtures), run in a child
process with a checkpoint every K systems; `publish.ts` (masks, perturbation) is not
ported. Slower: the TypeScript in a Web Worker with checkpoints in the results cache —
a reload resumes, a closed tab pauses.

## 9. Tests, for every step

Unit tests of what the page compiles and assembles; API tests of the executor
(checkpoint, pause mid-step, resume, restart, fencing, access); a twin fixture where
logic exists on both sides; one Playwright journey per computation: start, reload
mid-run, the same run, then pause and resume.

## 10. Status

- **Step 0, done**: `server_runs` (migration `e6a8c0e2b4d6` renames `concept_runs`),
  `services/server_runs/` (state, runs, executor, registry), `/server-runs` routes,
  `hooks/use-server-run.ts`; the concept runs on it unchanged.
- **Step 1, done**: `etl` runs (`server_runs/etl.py`), the ETL store mirroring them,
  the MCP tool starting them; API tests `test_server_run_etl.py`, store tests
  `etl-server-run.test.ts`, journey `etl-runs.spec.ts`. Found by the journey: a
  resume sends only the scripts left, so the run carries its position over by file.
- **Step 2, done**: `catalog` runs (`server_runs/catalog/`: `compute.py` the twin of
  `catalog-compute.ts` + `catalog-sql-fill.ts`, `executor.py`), templates with comment
  tokens filled in both modes, ties by UTF-16 code units (was `localeCompare`), the
  checkpoint = the results cache written with the catalog row under the run's fence
  (`state.fence`); `CatalogConfigTab` reads the run (`useServerRun`), the MCP tool
  starts it; `catalog-job-executor.ts` and `work.job` gone. Tests: twin fixture
  `catalog-run-spec.twin.test.ts` → `test_catalog_run_twin.py` (filler matrix,
  planning from the browser's rows, end to end on Parquet, resume of a page-paused
  cache, pause/resume mid-run); journey `catalog-runs.spec.ts` (not yet run).
- **Step 3, done**: generic `query_list` executor
  (`server_runs/query_list.py`, results route, `lib/server-runs/query-plan.ts`:
  `preparePlan`, `runPlanLocally`, `runResults`, `followServerPlan` — a signed plan
  joins only a run of its signature and replaces another); kinds `etl_quality`
  (concept comparison: `load-concept-quality.ts` compile/assemble, no more
  `catch {}`) and `database_stats` (Databases page + Quality Statistics, replacing
  the remembered query jobs). Tests: `test_server_run_query_list.py`,
  `load-concept-quality.duckdb.test.ts`, `query-plan.test.ts`,
  `database-stats.test.ts`; journey: second test of `etl-runs.spec.ts`.
- **Step 5, done**: kinds `cohort_run` (`lib/cohort-run-plan.ts`, `cohort-store`
  `executeCohort` + `rejoinCohortRun`) and `cohort_figures` (`cohortFiguresQueries`
  in `lib/cohort-report/model.ts`, `cohort-figures.ts`: a finished run of the same
  definition is read rather than computed again); runs and files dropped with the
  cohort. Tests: `cohort-run-plan.test.ts`, `cohort-report.duckdb.test.ts` (the plan
  says what the local path says), API `test_server_run_query_list.py`; journey
  `cohort-runs.spec.ts`.
- **Step 6, benchmark done**: `propagate` on the same equations, CPython 3.12
  against Node 26's V8: 6× slower at 500, 3,000 and 10,000 concepts (0.28 s / 1.7 s /
  5.7 s against 0.05 s / 0.29 s / 0.97 s), the same unknowns found. Within 10×:
  the Python port.
- **Step 6, done**: kind `catalog_audit` (`server_runs/catalog_audit/`: `compute.py`
  the twin of `auditPublished`, `executor.py` running it in a spawned process,
  checkpoint file every 500 systems or 1 s, result `results/audit`); scope = the
  catalog, `catalog:write` to start (what storing the audit needs), `catalog:read`
  to follow. The page builds the input (`auditInputOf`), and `useCatalogAudit`
  starts, pauses or resumes the run and keeps a finished one's audit once
  (`auditRunApplies`: same stamp, newer than the one kept). Findings sorted by code
  units in both (was `localeCompare`). Tests: `audit.twin.test.ts` →
  `test_catalog_audit_twin.py` (11 cases incl. a generated 300-concept catalog,
  resume from a checkpoint, the run end to end, pause midway and resume, access),
  `audit-runner.test.ts`. No journey yet.
- **Step 4, done**: kind `catalog_estimate`, a mode of the catalog executor
  (`spec.mode: "estimate"`): rankings, `state.fill` (top services, concept filter),
  then one query per crossing, each estimate stored as it lands in `stats_cache`
  (`catalog-estimate`, keyed by `estimateKey`), read by the page through
  `GET /data-catalogs/{id}/estimates` instead of its in-memory map (kept for
  client-only mode, same SQL via `compileEstimatePlan` + `fillCatalogSql`). Dropped
  with the catalog. Tests: the twin fixture's `estimate` (spec, the browser's
  queries and rows, its estimates) → `test_catalog_run_twin.py` (replay, run end to
  end, pause midway and resume, a kind runs only its mode). No journey.
- Found by the journeys: the ETL run's mirror lived in the Pipeline and Scripts
  tabs, so a run ending while the Quality check showed left the target "held for
  writing" for good; it now lives in the pipeline's page (`useEtlServerRunMirror`).
- Journeys: `long-runs`, `demo-runs`, `etl-runs` (pipeline, Quality check), `catalog-runs`
  (computation, estimate, audit), `cohort-runs`. Nothing left.
