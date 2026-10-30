# Planning — session planner

Read this at the start of a session and pick. One line per remaining item — what is
done is not listed: the as-built is in `docs/architecture.md`, and the design rationale
of finished efforts that the code still cites lives in `docs/design/`.

**Status**: 🔜 ready to do · 🤔 needs your decision · 💤 later/maybe
**Effort**: S (< ½ day) · M (½–2 days) · L (several days)

*Last checked against the code: 2026-09-30.*

## Priority

### Scale — billion-row databases — [scale-plan.md](scale-plan.md)

Concept list times out (504) and cannot be stopped on a ~1B-row Parquet database;
Data overview is slow on a 50M-row patient. Arbitrated 2026-10-02: concept counts
run like the catalog (browser-driven units, pause/resume), order below.

| St | Item | Effort |
|----|------|--------|
| 🔜 | 1–2. **[TO TEST]** Concept counts in resumable units + *Concepts* tab on every database (built on `feature/scale-concepts`, manual list in plan §5) | S |
| 💤 | Move the catalog and audit runners onto `lib/run-registry.ts` (the concept count already uses it) | S |
| 🔜 | 3. **[TO TEST]** Timeline + Notes honour the selected stay (shared `patient-scope.ts`); script-plugin ids quoted; bench in `scripts/bench/` | S |
| 🔜 | 4. **[TO TEST]** Data overview by zoom level: SQL density tiles for dense rows, event windows, debounce + cancel (`overview-tiles.ts`) | S |
| 💤 | Data overview: min/max per bucket (M4) to draw a dense numeric row as a band rather than a density | M |
| 🔜 | **[TO TEST]** Statistics tab warns when Parquet tables are not in patient order (server, Parquet folders) | S |
| 🔜 | User docs (linkr-website): Database › Concepts tab, the unsorted-Parquet warning and how to sort | S |

### Apache Doris + remote compute — [doris-plan.md](doris-plan.md)

Built on `feature/doris` (2026-10-09): `doris` engine (read-only login enforced),
heavy app queries translated and computed by Doris (437/555 real queries, 0
different; ×3 to ×30), remote `KILL QUERY` on cancel, Arrow Flight SQL for bulk
results as the optional `doris` extra with a warning banner.

| St | Item | Effort |
|----|------|--------|
| 🔜 | **[TO TEST]** In the app against the local Doris (plan §3.1) | S |
| 🤔 | The API image ships the `doris` extra (77253fe28). Postgres pushdown: measure on a remote server first. User SQL pushdown? (plan §3.2) | S |
| 💤 | Still slow on Doris: concept-list assemble (whole dictionary over MySQL), `mode()` profiles, ETL source / cohort derive / R-Py libs (plan §3.3) | M |
| 🔜 | User docs (linkr-website): connecting a Doris database | S |

## Heavy tasks as server jobs — [heavy-jobs-plan.md](heavy-jobs-plan.md)

Long work must not hang on one HTTP request through an SPE gateway (60 s → 504), nor run
two heavy DuckDB queries at once (container OOM). Inventory of every heavy task in §1.

| St | Item | Effort |
|----|------|--------|
| 🔜 | **[TO TEST]** Query job primitive + data catalog as proof of concept (plan §2–3, built 2026-10-14 on `feature/gateway-timeouts`) | M |
| 🔜 | **[TO TEST]** Concept counts (one job per step, assemblies inside the job), DQ runs (keep-going job, followed again after a closed tab), database statistics — and progress inside a query (`query_progress`, DuckDB only) on the step lines and in the Jobs panel (plan §2, §3 bis, built 2026-10-14 on `feature/heavy-jobs`) | M |
| 🔜 | **[TO TEST]** `deferred` backed by jobs (long work → cancellable `task` job, poll returns JSON or file), `/query` on it with a `heavy` lane for the app's heavy queries, every group-B route on it, compaction + vocabulary import as jobs, ETL as a job (WebSocket gone), event-loop blockers moved to threads, stats remembered across a closed tab (plan §3 ter, built 2026-10-14 on `feature/heavy-jobs`) | L |

## To test manually in the app

Built, never exercised by hand. Everything else below is still to build.

| St | What | Mode | Effort |
|----|------|------|--------|
| 🔜 | Workspace vocabularies & dictionaries: ATHENA import (full + subset + a second release), legacy vocabulary databases, INDICATE sync + update, resolution, SQL tab | both | M |
| 🔜 | Data catalog: variables & crossings, a resumed run, Pause/Stop, anonymization audit, Publish (Pages) | both | M |
| 🔜 | Derive a cohort → new DuckDB, and → new schema (Linkr-owned DuckDB, Postgres with writes allowed) | server | S |
| 🔜 | SPC plugin: add the widget to a dashboard. No plugin has a validator — this is the only check that exists | both | S |
| 🔜 | Server file picker end to end (`server-file-picker-plan.md` §6) | server | S |
| 🔜 | Versioning against a real remote: partial pull → push unblocked, conflicts, LFS path | both | S |
| 🔜 | Dataset editing & manual collection (cell edits, undo after reload, rename repairs filters, two people collecting) | both | M |
| 🔜 | Patient data: localStorage migration, server round-trip, export → reimport → export stability | both | S |
| 🔜 | Private catalog: add one with a token (Manage catalogs › Private repository), browse it, install a private entry from it; a second user without a token sees the "private catalog" error | server | S |
| 🔜 | SPE simulation (`docker/spe-sim/`): smoke test, then terminal, env installs through the mirror, Postgres datamart, `GATEWAY_WEBSOCKETS=off` (README § Test) | server | S |
| 🔜 | Concept value statistics precomputed (Concepts tab, *Statistics* ticked): on the large Doris — the units are computed by Doris (job panel times, no row stream over MySQL), a paused stats step resumes, a finished count adds its statistics without recounting, a concept's stats panel opens at once with "Precomputed" under its distribution; then *Count again* drops them | server | S |
| 🔜 | Doris syntax probe: `GROUP_CONCAT … SEPARATOR`, `CHAR(n)` without `USING utf8`, `LOWER()` on accented text, `STDDEV_SAMP`, `CAST(FLOOR) AS BIGINT`, `PERCENTILE_APPROX` — `apps/api/.venv/bin/python scripts/doris-syntax-probe.py` against the test Doris (login allowed to create a temp table; usage at the top of the script). Any FAIL → make that rule `NotPortable` in `remote_sql.py` | server | S |
| 🔜 | Setup wizard on a *virgin* instance (`LINKR_DATA_DIR=/tmp/…`): install → children cloned → decision recorded → no browser re-seed on a second machine | server | S |
| 🔜 | Suggestion engines (mapping editor › Manage suggestions): one-click BioLORD setup on a fresh data dir, build its index (Stop, then resume), Compute syntactic + semantic on a project (AI rows kept, *only missing*), a model from a server folder, re-import a vocabulary → index *out of date*; a configuration limited by concept class (drugs at the Clinical Drug level); MCP `semantic_search_vocabulary` with `concept_classes`, `get_vocabulary_concept` on a drug (components: strengths, dose form, brand); Docker image on Linux (torch CPU vs CUDA through `--torch-backend auto`) and through the SPE mirror (`LINKR_EMBEDDINGS_TORCH_BACKEND=`) | server | M |

## Embedded chat over LibreChat — [embedded-chat-plan.md](embedded-chat-plan.md)

Global right-hand chat panel in Linkr, the agent run by LibreChat's Agents API; history
owned by Linkr. **Parked 2026-10-05**: the API cannot pause a run for tool approval, so
actions (and any other MCP: GitLab, Jira…) would run unconfirmed. Reopen when it can
(plan §9). Until then: LibreChat in a tab beside Linkr.

| St | Item | Effort |
|----|------|--------|
| 💤 | Embedded chat — reopen when LibreChat's Agents API supports approval pause/resume (plan §9) | L |

## Skills — [skills-plan.md](skills-plan.md)

Product skills (tool procedures) ship with the MCP; method skills (statistics, EDA) and
local ones (a warehouse's querying rules) become a workspace **Skill entity**, shared
through the catalog. Agents get all of them through MCP tools (`list_skills`,
`get_skill`), so LibreChat needs no import. Local warehouse skills point to wiki pages
rather than copying them.

| St | Item | Effort |
|----|------|--------|
| 🤔 | Arbitrate plan §7.0: wiki `context` list, project-level skills | S |
| 🔜 | 1. Skill tools over the MCP's bundled skills, zip dropped from the LibreChat setup | S |
| 🔜 | 2. Product skills: dashboard, patient board, cohort (from [mcp-skills-advice.md](mcp-skills-advice.md)) | M |
| 🔜 | 3–5. Skill entity (model, export, `linkr-format`, catalog), editor, MCP reads it | L |
| 🔜 | 6. Method skills: statistics, EDA with the plotting theme, in `linkr-public-content` | M |
| 💤 | 7. Sync to LibreChat native skills | M |

## IDE — web apps — [web-apps-plan.md](web-apps-plan.md)

Run a **long-lived web server** from project code (Shiny, Streamlit, Dash, Gradio, plumber,
FastAPI/Flask, Panel, Marimo) and show it in an iframe inside Linkr. Server mode only.
Nothing exists yet; the closest prior art is `pty_kernel.py`. Frameworks are **presets**
(name, detection rule, argv template with `{port}`) over a raw `$PORT` command. An app is
its own detached process, never a kernel run, so the R/Python session stays usable.

| St | Item | Effort |
|----|------|--------|
| 🤔 | Arbitrate the plan (same-origin iframe + no sharing; `/api/v1/apps/…` prefix; registry owns lifecycle, job row only shadows; dev-only COEP `credentialless`) | S |
| 🔜 | 1. Extract `runtime_spec()` from `kernel._make()` | S |
| 🔜 | 2. `web_apps.py`: `AppManager` (detached spawn, port probe, readiness, log tail, killpg teardown, quota, idle sweep) — also fixes the killpg leak and the missing idle sweep in `pty_kernel.py` | M |
| 🔜 | 3. Presets table + detection + custom `$PORT` command | S |
| 🔜 | 4. `routes/apps.py`: start / stop / list / logs behind `ide:execute` | S |
| 🔜 | 5. Job-row shadow (`kind="app"`) + cancel hook | S |
| 🔜 | 6. Proxy: HTTP streaming + WS pump + `<base>` injection + `Location` rewrite | M |
| 🔜 | 7. Frontend: `AppTab`, toolbar + logs drawer, `RunButton` entry, apps in `JobsIndicator` | M |
| 🔜 | 8. nginx `proxy_buffering off`, dev COEP, `docs/architecture.md` | S |
| 🔜 | 9. **[TO TEST]** Matrix across the frameworks | M |

## Workspace vocabularies & data dictionaries — [workspace-vocabularies-plan.md](workspace-vocabularies-plan.md)

Built 2026-09-28 (library, dictionaries, resolution, SQL export). Left:

| St | Item | Effort |
|----|------|--------|
| 🔜 | Workspace export: **stop embedding the concept sets** — today every set is written in full to `concept-sets/*.json` (client `lib/entity-io.ts` and server `workspace_export_assemble.py`). Write one pointer per dictionary instead (repo URL, ref/commit, name), and on import re-download it from the repo or list it as missing. Same for the vocabulary inventory (`vocabulary_id` + version, never the data) | M |
| 🤔 | A dictionary with no repo (local import): not exported at all and reported as missing on import — or kept out of the workspace export by design? | S |
| 🔜 | Mapping-project pull: take the remote `conceptSets` refs (no pull path reads them yet) | S |

## Suggestion engines — as-built in [../architecture.md](../architecture.md) § Suggestion engines

Built 2026-10-27 on `feature/suggestion-embeddings`. Left:

| St | Item | Effort |
|----|------|--------|
| 🔜 | Semantic search keeps no model in memory: each `semantic_search_vocabulary` call loads it (a few seconds). A warm worker per configuration, stopped after idling | M |
| 🔜 | Bring a model in through the browser (zip upload); today: Hugging Face id, or a folder already on the server | S |
| 🔜 | Website docs: `concept-mapping/suggestions` still describes the terminal scripts — rewrite for the Manage suggestions tabs | S |
| 🤔 | Embed synonyms too (`concept_synonym`, one vector per synonym, max over a concept's vectors) | M |

## Reports — [reports-plan.md](reports-plan.md)

BlockNote document mixing prose with live Linkr widgets, presentable as slides (split on
`---`), exportable to md/HTML/DOCX/ODT/PDF/PPTX, filters frozen **per widget**. Arbitrated
2026-08-05; nothing built (the website already has `<PlannedFeature>` pages for it).

| St | Item | Effort |
|----|------|--------|
| 🔜 | 1. Model + persistence (`Report`, store, model + Alembic + service + routes, export/versioning) | M |
| 🔜 | 2. BlockNote editor (`@blocknote/shadcn`, dynamic import, i18n, Portal audit) | M |
| 🔜 | 3. `linkrWidget` custom block + slash-menu + "import from a dashboard" | M |
| 🔜 | 4. Per-widget filters (`resolveBlockFilters` + tests) | M |
| 🔜 | 5. Freeze figures (`figure-export` + `OffscreenWidgetCapture`) | M |
| 🔜 | 6. Presentation mode (`splitBlocksIntoSlides` + `computeFitScale`) | M |
| 🔜 | 7. Exports (md/HTML → DOCX/ODT/PDF via XL → PPTX via `pptxgenjs`) | L |

## eCRF / survey plugin — [survey-plugin-plan.md](survey-plugin-plan.md)

Three parsers (Goupile, REDCap, XLSForm/ODK) and the `survey-question` plugin are built;
only Goupile is reachable from the UI.

| St | Item | Effort |
|----|------|--------|
| 🔜 | Wire `redcap` / `xlsform` to the upload path — tested, but no `.tsx` calls them | S |
| 🔜 | Persist the schema to the dataset sidecar (`SURVEY_SIDECAR_KEY` is declared and used nowhere) | M |
| 🔜 | Dataset import from the IDE; i18n sweep | S/M |
| 🤔 | (b) user-overridable `measure` · (d) in-place chart switching | S / M |
| 💤 | More sources — **CDISC ODM first** (buys Castor + OpenClinica) | L |

## SPC / control charts plugin

`linkr-analysis-spc` is built; theory and formulas in `docs/design/spc-plugin-plan.md`.

| St | Item | Effort |
|----|------|--------|
| 💤 | Xbar-S, CUSUM, funnel plot, risk-adjusted VLAD | M |

## Server file picker — [server-file-picker-plan.md](server-file-picker-plan.md)

Databases (`serverPath`), the ATHENA folder, the concept-mapping source file (2026-09-28)
and, since 2026-10-05, the dataset import and the IDE upload can take a server file. Left:

| St | Item | Effort |
|----|------|--------|
| 🔜 | Category B, remaining screens: scores import, ETL upload — each needs a "read a server file" backend path | M |
| 🤔 | `fs_browse_roots` empty = the whole filesystem (still the default): keep, or default to a root? | S |

## Versioning

Pulls exist for projects, databases, ETL pipelines, mapping projects and schema presets.

### Collaborative versioning — [collaborative-versioning-plan.md](collaborative-versioning-plan.md)

Built 2026-10-28 → 10-30 on `feature/collab-versioning` (as-built: `docs/architecture.md`
§ Versioning): allowed internal git hosts, a 3-way pull over the export tree for every
scope (projects re-enabled), cards by subject on both sides, merge requests for every
scope, per-workspace review mode; round trip, matrix and merge-request journeys
against local repositories and `docker/forge-sim/`.

| St | Item | Effort |
|----|------|--------|
| 🔜 | **[TO TEST]** In the app: a pull on each kind (workspace, project, SQL, ETL, DQ, catalog, schema, database), Propose changes, review mode | M |
| 🔜 | Workspace pull: inline entities added or removed upstream (listed as not taken today), concept sets, service mappings, plugins | M |
| 🔜 | Pull for user plugins and settings through the same engine (plugins have no importer to re-apply a tree) | M |
| 🔜 | Conflict editing: an editable merged result for a text conflict (today: theirs or mine) | M |
| 🔜 | A wiki page's metadata (`_tree.json` element) and its `.md` offered as one element | S |
| 🔜 | User docs (linkr-website): pull by subject, merge requests, review mode, `LINKR_GIT_ALLOWED_HOSTS` | S |
| 🔜 | `npm run worktree:new`: `node_modules/.bin` links copied as absolute paths to the main checkout — Playwright loads twice, `test:e2e` fails in a worktree | S |

| St | Item | Effort |
|----|------|--------|
| 🔜 | Server guard: the commit-push routes still accept `paths=None`, which runs `git add -A` (`git_service.commit_push`) | S |
| 🔜 | `attachments/` on pull: check workspace wiki attachments and README images through the 3-way pull | S |
| 💤 | Server-side import (`POST /projects/import`, `/workspaces/import`) — last big client-offload | L |

## Fullstack backlog

Logging is in place: structlog to stdout, plus the **access log** (`core/audit.py`: one
JSON line per data-touching request → `data_dir/audit/YYYY-MM-DD.jsonl` + stdout, monthly
Parquet, hash chain, *Access log* page behind `audit-log:read`).

| St | Item | Effort |
|----|------|--------|
| 🔜 | Pipeline actually functional — the Lab Pipeline page is a canvas (palette, nodes, panel) with no execution behind it | L |
| 💤 | Multi-user concurrent editing (conflicts, locking) | L |
| 💤 | Several API workers — one today, and the access-log hash chain assumes it | M |

## Descriptive table

| St | Item | Effort |
|----|------|--------|
| 🔜 | p-value column when a group-by is active — neither `render/table1.py` nor `Table1Component` computes one (client + server + parity test) | M |
| 🔜 | Its tooltip: test, why it was chosen, statistic, warning marker (SAMPL: never a p without its test) | S |

## Default data & catalog

`data:fetch` runs in CI, the API image carries git-lfs (tested against LFS pointers), schema
presets are no longer auto-created, and the import dialog has its catalog tab.

| St | Item | Effort |
|----|------|--------|
| 🔜 | `linkr-portal`'s `build.sh`: check it uses the shared indexer rather than its own | S |
| 💤 | "Propose to catalog" prefill | S |

## Data quality standards — [dq-standards-plan.md](dq-standards-plan.md)

Thematic public DQ rule sets (DQD-derived: structure, sex plausibility, units; ours:
lab values, vital signs, ICU), quality profiles (checks picked across rule sets, run
on a database), stable check ids, run export and catalog publish as W3C DQV.

| St | Item | Effort |
|----|------|--------|
| 🔜 | Stable `checkKey`; quality profiles (checks picked across rule sets, overrides, release review) + Runs; DQ home with 3 widgets like concept mapping | L |
| 🔜 | DQD generator + the 3 DQD-derived public rule sets | M |
| 🔜 | `dqRunToDqv()`, run export, catalog publish with a "Data quality" section | M |

## Format package & public content

| St | Item | Effort |
|----|------|--------|
| 🔜 | Run `linkr-format validate` in the CI of the `linkr-public-content` repos — none has a `.gitlab-ci.yml` | S |
| 🤔 | `serializeProject` / `ProjectSpec` (build a project export tree from a compact spec, written for the deleted authoring MCP): no caller left — delete? | S |
| 💤 | Convert the bundled MIMIC-IV ETL to C/CR (its scripts still join `source_to_concept_map`) | M |
| 💤 | `00b_custom_vocabulary.sql`: only the seed loader generates it — remove? | S |

## Security & compliance — done, design in [../design/spe-security.md](../design/spe-security.md)

| St | Item | Effort |
|----|------|--------|
| 💤 | A1 follow-up: kernels under their own OS identity, no read access to `data_dir` (judged minor inside a per-project SPE) | L |
| 💤 | A4 follow-up: the same separate identity is what would hold against a hostile agent — today agent code in its own kernel can read `data_dir/secret.key` + `linkr.db` and so open saved database passwords; A4 only keeps them out of the API's answers | — (same item) |

## Permissions

| St | Item | Effort |
|----|------|--------|
| 🤔 | PO validation of the resources × actions catalogue: which blocks, at which level, default roles, edge cases (shared resources, project role `none`, workspace→project inheritance) | S (review) |
| 💤 | Minors: inline gating by context, organizations readable by all | S |

## Per-user database credentials — [per-user-db-credentials-plan.md](per-user-db-credentials-plan.md)

Built: personal accounts, per-user pools and caches, session-only passwords, access log,
*Database accounts* tab, *Access log* page. Left (plan §12, steps 11–12):

| St | Item | Effort |
|----|------|--------|
| 🔜 | IDE connections: split settings (per project) from login (per user), reusing `DatabaseCredential` | S |
| 🔜 | Per-workspace browse roots for file-based databases; `serverPath` registration behind `databases:manage` | M |
| 🔜 | *My activity* page (the route exists, no page) | S |

## Code quality

| St | Item | Effort |
|----|------|--------|
| 🔜 | Split `lib/entity-io.ts` (now 5.3k lines → export / import / clone); `seed-loader.ts` (1.9k) and `WorkspacesPage.tsx` (825) too | M |
| 🔜 | Plugins: import via Git — `PluginsTab.tsx` is the last bare `<input type="file">`; move it onto `ImportSourceDialog` | S |
| 🔜 | Seed loader: read `LICENSE.md` (and the entity docs) from the bundled default data | S |
| 🤔 | Regenerate the activity-dashboard seed (legacy `col-N` ids) → drop the `colIdMap` rescue in entity-io | S |
| 🤔 | Cohort schema migrations v1→v4 in `cohort-store`: remove once no old cohort persists | S |

## Other

| St | Item | Effort |
|----|------|--------|
| 💤 | ETL `source.` / `target.` role aliases in generated SQL instead of `ds_<alias>`, so scripts survive a round trip. Needs cross-schema support in server mode | L |
| 🔜 | Kernel `sql_query` truncates at 10,000 rows without a warning; cohort `id_list` misses ids stored as doubles ([mcp-skills-advice.md](mcp-skills-advice.md) § Linkr issues) | S |

## User documentation — [website-docs.md](website-docs.md)

Every gap between the app and linkr-website is listed there, not in the sections above.

## Long-term vision — [../vision-roadmap.md](../vision-roadmap.md)

Pillars 2 (Monitoring) and 3 (Deployment) not started.

---

*Reference documents, not efforts: [../health-dcat-ap.md](../health-dcat-ap.md),
[../ecrf-formats-licensing.md](../ecrf-formats-licensing.md).*
