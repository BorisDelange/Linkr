# Test audit log

Chronological log of test audits run with the `update-tests` skill. Newest entry on top.
Each audit covers the commits since the previous entry's `Last audited commit`.

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
