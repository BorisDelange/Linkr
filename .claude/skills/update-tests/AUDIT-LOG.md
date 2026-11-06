# Test audit log

Chronological log of test audits run with the `update-tests` skill. Newest entry on top.
Each audit covers the commits since the previous entry's `Last audited commit`.

---

## 2026-11-06 — The manual test list, what a machine can check

- Range: scoped to the manual list of `docs/planning/README.md` ("To test manually" + [TO TEST] rows), uncommitted on feature/docs-cleanup over 40dda3d7e — not a commit range
- Last audited commit: 40dda3d7e
- Added:
  - client `apps/web/e2e/client/dataset.spec.ts` — a cell edit survives a reload; undoing restores the value, for good; `@known-bug` undoing after a reload
  - client `apps/web/e2e/client/spc.spec.ts` — `@known-bug` a control chart added to a dashboard draws its chart
  - API `apps/api/tests/test_web_apps.py` — detection of gradio, panel, fastapi, flask, plumber by content; argv of panel, flask, fastapi; gradio's environment; the open tab's poll keeps an app from going idle
- Updated: `docs/testing.md` (client coverage)
- Removed: none, no strict duplicate found
- Known bugs re-checked: the two tagged above are new, both still failing. Both fixed the same day, tags dropped: the baseline is now saved with the rows, SPC rows are re-keyed by name. In the client build, undo after a reload keeps the edit: `parsedInput` rewinds current rows and a reload lost `_rawBaseline`. In the client build, a control chart always says "Not enough data": rows are keyed by column id, `SpcComponent` reads them by name (the journey passes with the rows mapped to names)
- Left for later: rename repairing filters through the collection dialog (the only UI calling `renameColumn`; `dataset-column-rename.test.ts` covers the logic); data catalog run; server file picker and second-machine wizard journeys; terminal and env installs in the SPE smoke test. `npm run test:e2e` still fails in a worktree (`.bin` links to the main checkout): run `node ../../node_modules/@playwright/test/cli.js test` from `apps/web`

## 2026-11-05 — Demo ETL pipeline run whole on the server

- Range: scoped to the server ETL runner and the vocabulary fill script generator (`query()` refused in pipeline scripts, fill script reading `linkr_target_concept_ids`), uncommitted on security/review-2026-11-05 over 41cf36c4a — not a commit range
- Last audited commit: 41cf36c4a
- Added:
  - tier `npm run test:etl` (`scripts/test-etl.mjs`) — prints the current fill script (`tests/etl-demo/fill-vocabulary-script.ts`, the Vocabulary tab's builder) into `.cache/etl-demo/`, runs the test below, prints `report.json`
  - API (slow, skipped without the tier) `apps/api/tests/test_etl_demo_pipeline.py` — MIMIC-IV demo + demo vocabulary as server-path Parquet folders, an OMOP 5.4 target from the schema DDL, the 31 scripts of `mimic-iv-demo-omop-cdm` posted to `…/etl-run` in tree order with the regenerated fill script; the seeded fill script refused with the regenerate hint; 100 persons, one observation period each, deaths = dates of death (31), a visit per admission, a note per discharge, clinical tables and eras filled, one `cdm_source`, `90_tests.sql` without `fail` outside the mapping rates, standard concepts pruned (13,677 of 14,937), every used concept the vocabulary holds copied, no staging table left
- Updated: `docs/testing.md` (tier table, § Demo ETL pipeline, slow tests), run-tests skill (tier `etl`, diff rule, `full` = six tiers), root `package.json` (`test:etl`)
- Removed: none
- Known bugs re-checked: none tagged
- Left for later: the three `90_tests.sql` mapping-rate thresholds fail on the demo (diagnoses 74.6 % < 80 %, ICD procedures 80.5 % < 90 %) and 14 hard-coded SNOMED ids (routes, operators, note language, discharge) are absent from target.concept — both because the demo vocabulary holds only redistributable terminologies; tolerated by the test, a content question for linkr-public-content (thresholds or a vocabulary-aware check). The pipeline is run through `etl-run`, not the UI's Run all / `etl-jobs` path, and not in the client (WASM) mode.

---

## 2026-10-19 — End-to-end journeys for the missing areas

- Range: e2e coverage of the app as of 8fe04fa42 (first audit; scoped to the journeys, not a commit range)
- Last audited commit: 8fe04fa42
- Added:
  - client `e2e/client/etl.spec.ts` — demo ETL pipeline listed, scripts carry their SQL, a script run against `source.` returns rows
  - client `e2e/client/concept-mapping.spec.ts` — demo mapping project progress, Mappings filter, a mapping's detail (source + target codes)
  - client `e2e/client/dataset.spec.ts` — a project dataset opens as a table
  - client `e2e/client/ide.spec.ts` — the IDE runs `03_example.sql` on MIMIC-IV Demo (111 stays, 90 patients, 15 deaths)
  - client `e2e/client/import-export.spec.ts` — project exported as a ZIP, deleted, re-imported, its dashboard computes
  - server `e2e/server/workspace.spec.ts` — sign in, new workspace, SQLite database uploaded and queried through the server, linked to a new project
  - unit: `seed-loader.test.ts` (ETL pipeline / SQL collection rows and script content), `role-prefix.test.ts` (sequence names), `value-coercion.test.ts` (HUGEINT/DECIMAL), `linkr-format seed-manifest.test.ts` (in-memory database)
- Updated: `playwright.config.ts` (`server-setup` project for first-run, `server` depends on it), `e2e/fixtures.ts` (`ADMIN`, `signIn`), `first-run.spec.ts` (uses `ADMIN`)
- Removed: none
- Known bugs re-checked: none tagged
- Bugs the journeys found, fixed: demo ETL pipeline never seeded (no `id` on the row) and its scripts seeded empty (manifest key lookup without `scripts/`), same for SQL collections — `seed-loader.ts`; `nextval('target.seq')` never resolved client-side — `role-prefix.ts`; HUGEINT/DECIMAL results shown as `"\"15\""` typed text — `engine.ts` + `value-coercion.ts`; mapping detail labelled the target code "Source concept code" — `MappingsTab.tsx`; an in-memory database (ETL target with a DDL, no Parquet) was never made a seed entity — `linkr-format/seed-manifest.ts`
- Left for later: the demo ETL cannot run whole in the browser (JSON extension disabled offline, Parquet target mounted as read-only views, published pipeline's target ref names "MIMIC-IV Demo OMOP 2", absent from the demo) — content/design, not a journey; data quality (demo has no rule set); git versioning (server only, needs a remote); Python/R in the IDE (Pyodide/webR downloads)
