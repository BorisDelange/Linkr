# Planning — session planner

Read this at the start of a session and pick. One line per open item; what is done is
not listed: the as-built is in [`../architecture.md`](../architecture.md), the rationale
of built features in [`../design/`](../design/).

Four lists, one per kind of next step: **Decide** (needs a person's call), **Test by
hand** (built, a machine cannot check it), **Build**, **Later** (no plan to start).

**Effort**: S (< ½ day) · M (½–2 days) · L (several days)

*Last checked against the code: 2026-11-06.*

## Decide

| Question | Effort |
|----------|--------|
| Reports, Pipeline execution, Skills, DQ standards have no code yet: which stay under *Build*, which go to *Later*? | S |
| Descriptive table p-value: observational studies only, with its test shown? The plugin's README warns against baseline p-values in randomised trials | S |
| `fs_browse_roots` empty = the whole filesystem for database paths and the workspace picker: keep with a warning, or default to a root? A new default must not stop running instances | S |
| `serializeProject` / `ProjectSpec` have no caller left but their tests: delete, and rewrite the round-trip test that uses them? | S |
| Share a web app or embed it in a dashboard: needs an origin of its own per app (wildcard subdomain), since the same origin lets an app read its viewer's Linkr token | L |
| Skills: arbitrate [skills-plan.md](skills-plan.md) §7.0 (wiki `context` list, project-level skills) | S |
| Doris: Postgres pushdown after a measure on a remote server; user SQL pushdown outside the console ([doris-plan.md](doris-plan.md) §3.2) | S |
| Permissions: validate the resources × actions catalogue (blocks, levels, default roles, shared resources, project role `none`, workspace→project inheritance) | S |
| Suggestion engines: embed synonyms too (`concept_synonym`, max over a concept's vectors)? | M |
| eCRF: user-overridable `measure`; in-place chart switching | S / M |
| Regenerated seeds no longer hold `col-N` ids: keep the `colIdMap` bridge in `entity-io` for older exports, or drop it? | S |
| Cohort schema migrations v1→v5 in `cohort-store`: remove once no old cohort persists? | S |
| A dictionary with no repo travels whole in the workspace export (`concept-sets/<slug>.json`): confirm this as the rule | S |

## Test by hand

Built, and beyond what the automated journeys can check.

| What | Mode | Effort |
|------|------|--------|
| Scale, on a ~1B-row database: Concepts tab counts with pause and resume ([scale-plan.md](scale-plan.md) §5), Timeline + Notes on a selected stay, Data overview zoom levels, the unsorted-Parquet warning | both | S |
| Concept profiles: percentages, SQL dialog, store, concept panel, mapping extraction; a job paused then reopened ([concept-profiles-plan.md](concept-profiles-plan.md) §7) | both | S |
| Server-owned concept runs on a real warehouse: Concepts tab counts + statistics and a mapping extraction, reloaded, paused, resumed, the server restarted mid-run, a hung query stopped within its deadline ([server-runs-plan.md](server-runs-plan.md) §8) | server | S |
| SQL Server and Oracle added through the dialog against the SPE datamarts | server | S |
| Doris against the local Doris ([doris-plan.md](doris-plan.md) §3.1), then the syntax probe: `apps/api/.venv/bin/python scripts/doris-syntax-probe.py`; any FAIL → that rule becomes `NotPortable` in `remote_sql.py` | server | S |
| Heavy jobs with a datamart slow enough to pass the gateway timeout: counts, DQ, stats, `deferred` routes, ETL as a job, Jobs panel progress ([heavy-jobs-plan.md](heavy-jobs-plan.md)) | server | M |
| Web apps: really launching the Gradio, plumber, Panel, FastAPI and Flask presets (detection and commands are tested); one real long session past the idle stop | server | S |
| Vocabularies and dictionaries: ATHENA import (full, subset, a second release), legacy vocabulary databases, dictionary sync + update, resolution, SQL tab | both | M |
| Data catalog: variables and crossings, a resumed run, Pause/Stop, anonymization audit, Publish (Pages) | both | M |
| Quality profiles: home → create (database required) → pick a whole rule set and some checks of another → run → History; rename a check in its rule set and see the profile keep it; delete a rule set and remove it from the profile; a reload mid-run, then Pause → reload → Resume, and Start over (server); close the tab mid-run and find it recorded in the History ([dq-standards-plan.md](dq-standards-plan.md) §3) | both | S |
| DQ groups and bilingual checks: a manual check's name and description in EN and FR; groups created with both names, nested, dragged (checks and groups, several checks in Select mode), deleted keeping their checks; an existing rule set after the migration (names under EN, table groups intact); a profile's Checks tab and *By group* results showing the nesting; a profile Report in HTML, PDF and Word, with and without the passed checks and the SQL | both | S |
| Derive a cohort through the UI → new DuckDB, and → new schema (Linkr-owned DuckDB, Postgres with writes allowed) | server | S |
| SPC widget added to a dashboard, server mode | server | S |
| Server file picker end to end ([server-file-picker-plan.md](server-file-picker-plan.md) §6) | server | S |
| Versioning against a real forge, with the LFS path | both | S |
| Dataset editing and manual collection: a rename repairing filters through the collection dialog, two people collecting, editing in server mode | both | M |
| Patient data: localStorage migration, server round trip, export → reimport → export stability | both | S |
| Private catalog: add one with a token, browse it, install a private entry; a second user without a token sees the error | server | S |
| SPE simulation: terminal and env installs through the mirror, Postgres datamart | server | S |
| Setup wizard: no browser re-seed on a second machine | server | S |
| Suggestion engines (Manage suggestions): BioLORD setup on a fresh data dir, index build (Stop, resume), Compute on a project, a model from a server folder and by upload, out-of-date index, a configuration limited by concept class; MCP `semantic_search_vocabulary` with `concept_classes`; Docker image on Linux, and through the SPE mirror | server | M |
| Schema classes: step 2b, and step 11's custom SQL relation with two-part names in a real run ([schema-classes-plan.md](../design/schema-classes-plan.md)) | server | S |

## Build

### Data engines

| Item | Effort |
|------|--------|
| Server-owned runs for every long computation: ETL pipeline, data catalog (Python twin), ETL Quality, catalog estimate, cohorts, disclosure audit ([server-runs-2-plan.md](server-runs-2-plan.md)) | L |
| Oracle, user SQL (editors, notebooks, ETL): fetch each table through `oracle_client` with its columns and simple filters, rather than whole through the extension ([duckdb-2-plan.md](duckdb-2-plan.md)) | M |
| Doris: `remote_query()` for R and Python; cohort derive reads source tables whole (`cohort_derive.py`); the validator refuses `connectionConfig`, which `entity-io` exports | M |
| Retire `concept_stats_caches` for the profile store ([concept-profiles-plan.md](concept-profiles-plan.md) step 4) | S |
| Heavy jobs: `git status` / `diff` on `deferred`; `filesrc_` paging | S |

### Reports — [reports-plan.md](reports-plan.md)

BlockNote document mixing prose with live widgets, presentable as slides, exportable. `ReportsPage` is a stub.

| Item | Effort |
|------|--------|
| 1. Model + persistence (`Report`, store, model + Alembic + service + routes, export/versioning) | M |
| 2. BlockNote editor (`@blocknote/shadcn`, dynamic import, i18n, Portal audit) | M |
| 3. `linkrWidget` custom block + slash-menu + "import from a dashboard" | M |
| 4. Per-widget filters (`resolveBlockFilters` + tests) | M |
| 5. Freeze figures (`figure-export` + `OffscreenWidgetCapture`) | M |
| 6. Presentation mode (`splitBlocksIntoSlides` + `computeFitScale`) | M |
| 7. Exports (md/HTML → DOCX/ODT/PDF via XL → PPTX via `pptxgenjs`) | L |

### Skills — [skills-plan.md](skills-plan.md)

| Item | Effort |
|------|--------|
| 1. `list_skills` / `get_skill` over the MCP's bundled skills, zip dropped from the LibreChat setup | S |
| 2. Product skills: dashboard, patient board, cohort (from [mcp-skills-advice.md](mcp-skills-advice.md)) | M |
| 3–5. Skill entity (model, export, `linkr-format`, catalog), editor, MCP reads it | L |
| 6. Method skills: statistics, EDA with the plotting theme, in `linkr-public-content` | M |

### Data quality standards — [dq-standards-plan.md](dq-standards-plan.md)

| Item | Effort |
|------|--------|
| 🚧 Quality profiles: built on `feature/dq-profiles` (model, home with 2 widgets, checks + add dialog, runs, `checkKey`, export/import, git link); left: profiles in the workspace export / seed / catalog, MCP tools | M |
| DQD generator + the 3 DQD-derived public rule sets | M |
| `dqRunToDqv()`, run export, catalog publish with a "Data quality" section | M |

### eCRF — [survey-plugin-plan.md](survey-plugin-plan.md)

| Item | Effort |
|------|--------|
| Wire `redcap` / `xlsform` to the upload path: the dropdown offers both, they fall through to a plain parse | S |
| Persist the schema to the dataset sidecar (`SURVEY_SIDECAR_KEY` is declared and used nowhere) | M |
| Dataset import from the IDE | S |

### Versioning

| Item | Effort |
|------|--------|
| Commit-push routes accept `paths=None`, which runs `git add -A` (`git_service.commit_push`): refuse it | S |
| Pull: workspace README images are offered by the Information card, and `applyWorkspaceInfo` seems not to write them. Check, then fix | S |
| Mapping-project pull: take the remote `conceptSets` refs | S |
| Workspace export: the vocabulary inventory (`vocabulary_id` + version), so an import can say what is missing | S |
| `npm run worktree:new`: `node_modules/.bin` links copied as absolute paths to the main checkout, so Playwright loads twice and `test:e2e` fails in a worktree | S |

### Access and databases — [per-user-db-credentials-plan.md](../design/per-user-db-credentials-plan.md)

| Item | Effort |
|------|--------|
| IDE connections: split settings (per project) from login (per user), reusing `DatabaseCredential` | S |
| Per-workspace browse roots; `serverPath` registration behind a `databases:manage` permission, which does not exist yet (gate today: `databases:write`) | M |
| *My activity* page: the API exists (`listMyActivity` has no caller), no front route | S |

### Identity and agents

| Item | Effort |
|------|--------|
| Schema presets: retire `presetId` (193 hits, `preset_id` column), then `omop-cdm-5.3/mapping.json` ([schema-preset-identity-plan.md](../design/schema-preset-identity-plan.md) steps 5–6) | M |
| Agents: action log and per-turn undo ([ai-agents-plan.md](../design/ai-agents-plan.md) §4c) | L |

### Rest of the app

| Item | Effort |
|------|--------|
| Lab Pipeline: execution behind the canvas (`routes/pipelines.py` is CRUD only) | L |
| Descriptive table: p-value column when a group-by is active, tooltip with its test (client + server + parity test). After the decision above | M |
| Server file picker: scores import, ETL upload, each with a "read a server file" backend path; merge the two add-database dialogs | M |
| Semantic search: a warm worker per configuration, stopped after idling (each call now loads the model) | M |
| Kernel `sql_query` truncates at 10,000 rows without a warning; cohort `id_list` misses ids stored as doubles (`CAST AS VARCHAR`, [mcp-skills-advice.md](mcp-skills-advice.md)) | S |
| Seed loader: `seed-loader.ts:1468` forces `stcm`, a mode with no C/CR. Check whether that branch fires, as it would write the wrong shape | S |
| Remove `00b_custom_vocabulary.sql` handling: only the seed loader and `vite-plugin-seed-hashes` still read it | S |

### Format, content, code quality

| Item | Effort |
|------|--------|
| Run `linkr-format validate` in the CI of the `linkr-public-content` repos | S |
| `linkr-portal`'s `build.sh` has its own bash indexer instead of `buildSeedManifest`: share it, and fix the "shared with linkr-portal" comment in `fetch-default-data.ts` | M |
| Split `lib/entity-io.ts` (5.5k lines → export / import / clone); `seed-loader.ts` (2k), `WorkspacesPage.tsx` (840) too | M |
| Plugins: import via Git, moving `PluginsTab.tsx`'s file input onto `ImportSourceDialog` | S |
| Seed loader: read `LICENSE.md` and the entity docs from the bundled default data | S |

### User documentation — [website-docs.md](website-docs.md)

Every gap between the app and linkr-website is listed there, and only there.

## Later

No plan to start; each stays here until someone has a reason.

| Item | Effort | Wakes up when |
|------|--------|---------------|
| Embedded chat over LibreChat ([embedded-chat-plan.md](embedded-chat-plan.md)) | L | LibreChat's Agents API can pause a run for approval (plan §9). Until then: LibreChat in a tab beside Linkr |
| Merge requests from Linkr and workspace review mode (UI hidden, `GIT_PROPOSALS_ENABLED`, routes and tests kept) | M | Decided who sees and accepts a proposal inside Linkr |
| Move the server to DuckDB 2.0: Oracle with read-only attach + pushdown ([duckdb-2-plan.md](duckdb-2-plan.md)) | M | A stable 2.0.x patch is out (2.0.1 is still dev) |
| Kernels under their own OS identity, no read access to `data_dir`. Also what would hold against a hostile agent ([spe-security.md](../design/spe-security.md)) | L | The per-project SPE stops being enough |
| Multi-user concurrent editing (conflicts, locking) | L | |
| Several API workers (the access-log hash chain assumes one) | M | |
| Server-side import (`POST /projects/import`, `/workspaces/import`) | L | |
| Catalog and audit runners on `lib/run-registry.ts` | S | |
| Data overview: min/max per bucket (M4) for a dense numeric row | M | |
| Concept profiles: resume on reopen; catalog totals from the store | S | |
| Doris slow paths: `mode()` profiles, ETL source, R and Python libs ([doris-plan.md](doris-plan.md) §3.3) | M | |
| Web apps: Marimo preset; several apps per project; per-app resource ceiling | S | |
| Skills: sync to LibreChat native skills | M | |
| eCRF: more sources, CDISC ODM first (buys Castor + OpenClinica) | L | |
| SPC: Xbar-S, CUSUM, funnel plot, risk-adjusted VLAD | M | |
| "Propose to catalog" prefill | S | |
| Schema classes: steps 12–13 ([schema-classes-plan.md](../design/schema-classes-plan.md)) | M | |
| Long-term vision, pillars 2 (Monitoring) and 3 (Deployment): [vision-roadmap.md](vision-roadmap.md) | L | |
