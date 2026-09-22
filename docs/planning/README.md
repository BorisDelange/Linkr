# Planning — session planner

Read this at the start of a session and pick. One line per remaining item.
The as-built is in `docs/architecture.md`; details for each item live in the linked plan.

**Status**: 🔜 ready to do · 🤔 needs your decision · 💤 later/maybe
**Effort**: S (< ½ day) · M (½–2 days) · L (several days)

## IDE — web apps — [web-apps-plan.md](web-apps-plan.md)

Run a **long-lived web server** from project code (Shiny, Streamlit, Dash, Gradio, plumber,
FastAPI/Flask, Panel, Marimo) and show it in an iframe inside Linkr. Server mode only.
Nothing exists yet; the closest prior art is `pty_kernel.py` (the only detached long-lived
child process). Framework-agnostic by construction: frameworks are **presets** (a name, a
detection rule, an argv template with `{port}`), the runtime only knows "a process that will
listen on 127.0.0.1". A raw custom command with `$PORT` is the primitive underneath.

**An app never blocks the IDE**: it is its own detached process, never a kernel run, so the R
or Python session stays warm and usable while it serves. `AppManager` owns the lifecycle; a
`kind="app"` job row shadows it so a running app stays visible (and stoppable) in the Jobs
panel after its tab is closed — but never goes through `jobs.launch()`, whose semaphore is
bounded at 2.

Two things need arbitration before step 6: **same-origin iframes** — an app can read
`linkr-access-token`, which is why the plan refuses to make apps shareable until a
wildcard-subdomain split exists — and the **dev-only COEP `credentialless`** header in
`vite.config.ts`.

| St | Item | Effort |
|----|------|--------|
| 🤔 | Arbitrate the plan (same-origin iframe + no sharing; `/api/v1/apps/…` prefix; registry owns lifecycle, job row only shadows) | S |
| 🔜 | 1. Extract `runtime_spec()` from `kernel._make()` — kernels and apps resolve interpreter/env identically | S |
| 🔜 | 2. `web_apps.py`: `AppManager` (detached spawn, port probe, background readiness, log tail, killpg teardown, quota, idle sweep) — also fixes the same killpg leak in `pty_kernel.py` | M |
| 🔜 | 3. Presets table + detection (name + content regex) + custom `$PORT` command | S |
| 🔜 | 4. `routes/apps.py`: start / stop / list / logs behind `ide:execute` | S |
| 🔜 | 5. Job-row shadow (`kind="app"`) + cancel hook reaching `AppManager.stop()` | S |
| 🔜 | 6. The proxy: HTTP streaming + WS pump + `<base>` injection + `Location` rewrite | M |
| 🔜 | 7. Frontend: `AppTab` (full tab, `TerminalTab` model), toolbar + logs drawer, `RunButton` entry, apps in `JobsIndicator` | M |
| 🔜 | 8. nginx `proxy_buffering off`, dev COEP, `docs/architecture.md` | S |
| 🔜 | 9. **[TO TEST]** Matrix across all 6 frameworks — one proxy for all, and the session stays usable throughout | M |

## AI agents — [ai-agents-plan.md](ai-agents-plan.md)

**Re-scoped 2026-09-02**: one project-wide sidebar, **server mode only**. An external
agent binary (OpenCode by default) brings the loop, memory and compaction; Linkr brings
the UI and the actions, over two open protocols — **ACP v1** (typed events to our own
UI, `session/request_permission` renders our dialog) and **MCP** (`linkr-live` for the
running instance, `linkr-authoring` for files). The per-page copilot and the in-house
agentic loop are dropped; the WASM assistant is deleted (plan §10).

Provider config is **built** (workspace-scoped, owner-only, Fernet, derived `is_local`,
`LINKR_ALLOW_REMOTE_LLM=false`). The clinician profile is enforced by *which MCP servers
are passed to `session/new`*, not by prompting.

**Amended 2026-09-22**: `linkr-live` is a **public interface**, not an internal component
— third-party MCP clients (LibreChat, Claude Desktop, Cursor) consume it like the ACP
sidebar does, so it moves ahead in the order and gains a per-project `ApiToken` entity.
MCP has no confirmation hook, so §5's "nothing is written unseen" does not hold on that
surface (plan §4b).

| St | Item | Effort |
|----|------|--------|
| ✅ | `LlmProvider` + proxy + settings tab + per-surface approval | M |
| 🔜 | Skills entity (workspace-scoped, one entity = one skill; file tree like SQL collections) | M |
| 🔜 | **MCP `linkr-live`** (http, dashboard tools) + `ApiToken` (per-project, revocable) + rename existing to `linkr-authoring` — serves both surfaces, ships alone | M/L |
| 🔜 | Project skill selection + generated `AGENTS.md` + materialise `.agents/skills/` | S/M |
| 🔜 | ACP broker in FastAPI (stdio spawn, WS relay, session lifecycle) — `execution.py` is the model | L |
| 🔜 | Sidebar: ACP event rendering, `request_permission`, per-turn undo, clinician/dev modes | L |
| 🔜 | Notification WS + store reload (stores are optimistic-write, nothing listens to the DB) — client-agnostic, so an external client refreshes the open tab too; do not reload a dirty open editor | S/M |
| 🔜 | Delete `lib/agent/` + `DashboardAgentSidebar.tsx` — salvage the confirm/undo UI and tool vocabulary first | S |
| 💤 | `linkr-live` extended: cohorts, datasets · workspace agent (narrow tools) | M |

## Reports — [reports-plan.md](reports-plan.md)

BlockNote document mixing prose with live Linkr widgets, presentable as slides (split on
`---`) and exportable to md/HTML/DOCX/ODT/PDF/PPTX. Filters are frozen **per widget**. Design
arbitrated 2026-08-05; `xl-*` exporters are GPL-3.0 (compatible, no commercial license).

| St | Item | Effort |
|----|------|--------|
| 🔜 | 1. Model + persistence (`Report`, store, model + Alembic + service + routes, export/versioning) | M |
| 🔜 | 2. BlockNote editor (`@blocknote/shadcn`, dynamic import, i18n, missing `form`/`toggle`, Portal audit) | M |
| 🔜 | 3. `linkrWidget` custom block + slash-menu + "import from a dashboard" | M |
| 🔜 | 4. Per-widget filters (extract sidebar controls, popover, badge, `resolveBlockFilters` + tests) | M |
| 🔜 | 5. Freeze figures (reuse `figure-export` + `OffscreenWidgetCapture`, blobs, refresh) | M |
| 🔜 | 6. Presentation mode (port `splitBlocksIntoSlides` + `computeFitScale`, overlay, shortcuts) | M |
| 🔜 | 7. Exports (md/HTML → DOCX/ODT/PDF via XL → PPTX via `pptxgenjs`) | L |

## Database schemas — [database-schemas-plan.md](database-schemas-plan.md)

A source rarely lives in one namespace — MIMIC-IV is `hosp` + `icu` + `note`, eHOP spreads
56 tables over 11 Oracle schemas — but a mapping addresses a table by a bare name and a
Parquet import drops the folder it came from. Lossy, not cosmetic: eHOP 4.4 has two
different `EHOP_PATIENT` (de-identified `EDBM_EDS`, nominative `EDBM_ZPAT`), so one was
simply unreachable and shipped commented out of `schema.ddl`. DuckDB handles this fine; the
limit was ours — we emitted `"schema.table"` as **one** quoted identifier, which names a
table containing a dot. **Steps 1–6 are done**; what remains is confirming the chain in the
app and pushing the presets.

**`search_path` first, qualification second**: with the source's schemas on the path, every
existing bare-name mapping *and* the `source.<table>` of both ETL pipelines keeps resolving
untouched, so nothing migrates on day one and migration is then per-script (a three-part and
a two-part name join in one query). Measured on the real 36-file MIMIC-IV folder, in Python
and R alike. Step 1 is not optional: with schemas but no `search_path`, `source.patients`
fails and **both pipelines break**.

| St | Item | Effort |
|----|------|--------|
| ✅ | 1. `search_path` from the attached schemas in `_attach_role` (+ deterministic order) | S |
| ✅ | 2. `_table_of` + `extractTableName` return `(schema, table)`, views per schema (flat folders unchanged) | M |
| ✅ | 3a. Client mode mounts a folder as a catalog, not a schema — `role-prefix.ts` needed no change | S |
| ✅ | 3. `schema?` on the mapping + `qualify()` + the 161 call sites + editor + `linkr-format` (+ its Python twin) | M/L |
| ✅ | 4. MIMIC-IV `knownTables` matches the tables the schema declares | S |
| ✅ | 5. MIMIC-IV DDL declares hosp/icu/note and qualifies its 35 tables + 75 constraints; mapping names them | M |
| ✅ | 6. The five eHOP presets carry their Oracle schemas; 4.4's nominative EHOP_PATIENT is declared again | M |
| 🔜 | **[TO TEST]** Re-import both folders in the app: table counts, Patient Data, and both ETL pipelines | M |
| 🔜 | Push the schema presets once the whole chain is confirmed in the app | S |

Two things to know when testing. A folder imported in **client mode before this**
was mounted as a schema, so it needs unmounting and remounting; server mode is
unaffected. And a bare table name still resolves to whichever schema comes first
on the search path — which is why the eHOP presets qualify, and why a preset whose
source has homonyms should too.

## Schema preset identity — [schema-preset-identity-plan.md](schema-preset-identity-plan.md)

Schema presets were the only entity whose `presetId` played all three roles at once (local
PK, user-facing slug, cross-instance identity), where everything else splits them into
`id` + `entityId` + `lineageId`. Steps 1–4 moved both keys (IndexedDB v41, server revision
`e6f7a8b9c0d1`) with **no data movement** — step 2's backfill made `id == preset_id` on
every existing row, so the on-disk repo rename and the `git_sync_state` rewrite are no-ops
there. `presetId` still names the HTTP routes and the export format; retiring it is step 5.

| St | Item | Effort |
|----|------|--------|
| ✅ | Steps 1–4: id drift fixed, `id` + `entityId` added, IndexedDB v41 + server PK both keyed on `id`, URL shortened like the others | L |
| 🔜 | Step 5: retire `presetId` — **started**: the URLs no longer carry it and the root export file drops it. Left: `mapping.presetId`, the route bodies, the Pydantic schemas (where `preset_id` is still *required* while `id`/`entity_id` are optional) and the server export path | M |
| ✅ | Retired the built-in `SCHEMA_PRESETS` table and `lib/schema-ddl/`: every schema is an installed entity now, so a seeded or cloned database carries its own mapping and a bare preset id is refused rather than silently unmapped | M |

## eCRF / survey plugin — [survey-plugin-plan.md](survey-plugin-plan.md)

Import layer built and tested (166 tests): one XLSForm-based model, three parsers
(Goupile, REDCap, XLSForm/ODK), normalisation + inference, parser dropdown in the upload
dialog. The `survey-question` plugin ships with server parity, split into a pure Block
(so Reports can map over the questions) and the dashboard Component. The format survey and
the **licensing review** are finished research, moved to [../ecrf-formats-licensing.md](../ecrf-formats-licensing.md).

| St | Item | Effort |
|----|------|--------|
| 🔜 | Wire `redcap` / `xlsform` to the upload path — both parsers are tested but never called from a `.tsx`; only Goupile actually parses | S |
| 🔜 | Persist the schema to the dataset sidecar (`SURVEY_SIDECAR_KEY`, keyed by column NAME); declared but referenced nowhere, everything rides on inference | M |
| 🔜 | Dataset import from the IDE; i18n sweep | S/M |
| 🤔 | (b) user-overridable `measure` · (d) in-place chart switching (priority-based, as SurveyJS) | S / M |
| 💤 | LimeSurvey / Qualtrics / Castor / OpenClinica — **CDISC ODM is the highest-value target** (buys Castor + OpenClinica, MIT schemas) | L |

## SPC / control charts plugin — [spc-plugin-plan.md](spc-plugin-plan.md)

**Built, needs manual testing in the app.** Replaces the two generic R scripts NeoCLIP
copy-pasted inline into 39 widgets (~1 MB in one dashboard document, already drifted: the
CLABSI widget forked to add a device-days denominator the other 18 never got). One
component plugin, `linkr-analysis-spc`: p/P'/u/U'/c/np/I-MR/EWMA/g/t, NHSN overlap and
device-days denominators, Anhoj runs rules, Phase I/II baseline. Pure maths in `lib/spc/`
(92 Vitest) + server parity in `render/spc.py` (125 pytest asserting on printed values).

| St | Item | Effort |
|----|------|--------|
| 🔜 | **[TO TEST]** Load it in the app: add the widget to a dashboard, both client and server mode. No plugin has a validator — this is the only check that exists | S |
| 🔜 | Migrate NeoCLIP's 39 inline widgets; **18 of the 20 EWMA ones will change numbers** (they set a denominator the R script silently ignored) — a conversation to have with their readers | M |
| 🔜 | Delete micu-clip's `_sources/spc_*.R` once the widgets are migrated | S |
| 💤 | Xbar-S, CUSUM, funnel plot (Spiegelhalter), risk-adjusted VLAD via the expected column | M |

## Cohorts — patient review tab — [cohort-patient-review-plan.md](cohort-patient-review-plan.md)

A third tab after Attrition showing the **patient charts of the current result set**,
so a query can be reviewed without creating (then deleting) a cohort. Reuses the
Patient data widgets — one configuration per project, not several boards.

| St | Item | Effort |
|----|------|--------|
| 🤔 | Reserved `PatientDashboard` vs a new entity; transient ids vs SQL subquery | S (decision) |
| 🔜 | `'review'` tab + patient selector wired to `PatientChartContext` | M |
| 🔜 | Board configuration reusing `PatientChartGrid` | M |
| 💤 | Cohort-level (aggregate) widgets — different props contract | L |

## Server file picker — [server-file-picker-plan.md](server-file-picker-plan.md)

**Lot 1 built, needs manual testing in the app.** In server mode a file database
could only be created by uploading bytes from the user's machine — impossible for
data an admin already put on the server, and blocked outright past the 2 GB
ceiling. `serverPath` now points a database at data where it lies (no copy),
through one shared `ServerPathPickerDialog` that also lists files (the old folder
picker showed directories only). Boundary: `fs_browse_roots`, re-enforced where
the config is persisted, never an ETL target, stripped from exports.

The inventory of all 32 file-entry points is in the plan: 3 done, 5 candidates
(category B), ~24 upload-only by design.

| St | Item | Effort |
|----|------|--------|
| ✅ | Service + scoped routes + shared picker + `serverPath` end to end + ATHENA folder | L |
| 🔜 | **[TO TEST]** End to end in the running app, server mode (plan §6) | S |
| 🔜 | Category B: datasets, mapping source, scores, IDE and ETL uploads — each needs a "read a server file" backend path | M |
| 🤔 | `fs_browse_roots` empty = the whole filesystem: keep, or default to a root? | S |

## Databases — datamarts — [database-page-datamarts-plan.md](database-page-datamarts-plan.md)

The database detail **page with tabs** shipped (Overview / Statistics / Schema; the old
right-hand sheet is retired). What remains is **derived sub-databases**: select patients
with the cohort criteria builder, then either materialise a new Parquet-backed
`DataSource` or create a schema in the source database. The criteria builder gets
**extracted and shared**, not forked.

| St | Item | Effort |
|----|------|--------|
| ✅ | Database detail page with tabs, sheet retired | M |
| 🤔 | Naming (datamart?), entity shape, and where the cohort/datamart line sits | S (decision) |
| 🔜 | Extract the cohort criteria builder into a shared component | M |
| 🔜 | Datamart entity + builder + provenance (parent, criteria, built-at) | L |
| 🔜 | Mode (a): materialise to a new Parquet-backed `DataSource` | M |
| 🤔 | Mode (b): create a schema in the source DB (permission + engine support) | L |
| 🤔 | Data quality tab: run a DQ rule set against a database | M |

## Versioning

Pull redesign, server-side export and source-concept-id ownership all shipped; the
as-built is `docs/architecture.md` § Versioning. Plan retired 2026-09-03. What is left:

| St | Item | Effort |
|----|------|--------|
| 🔜 | **[TO TEST]** Manual end-to-end against a real remote: partial pull → push unblocked, conflicts, LFS path | S |
| 🔜 | Generalise the pull shell to the tail of push-only scopes (project, ETL, mapping project and schema preset already pull through `PullPanel`) | S/M |
| 🔜 | `attachments/` pull — a pulled README can reference images that never arrive | S/M |
| 🔜 | Server-side guard: refuse `paths=None` (git add -A) on the commit-push HTTP route | S |
| 💤 | Server-side import (`POST /projects/import`, `/workspaces/import`) — last big client-offload | L |

## Fullstack backlog

| St | Item | Effort |
|----|------|--------|
| 🔜 | Pipeline actually functional (end-to-end transforms) | L |
| 💤 | Multi-user concurrent editing (conflicts, locking) | L |
| 💤 | Job queue / multi-worker perf (uvicorn is 1 worker) | M |
| 💤 | Cosmetic: drop `render` from the `/execute` purpose docs/enum | S |
| 💤 | Optional: surface long code runs as `kind="run"` jobs in the panel (Stop + streaming already work) | S |

## Dataset editing, manual collection & dataset timeline — [dataset-edit-plan.md](dataset-edit-plan.md)

Arbitrated 2026-09-06, **built 2026-09-06/07** (`f43f89bb` → `31341652` + the collection
commit). A dataset is no longer a read-only import: it is edited cell by cell, filled in
patient by patient from Patient data, and plotted next to OMOP concepts on the same
timeline. One foundation carries all three — an **ordered replayable ops log over the
immutable raw** (`raw → parse → replay → parquet`), living as an `ops` section of the
existing `dataset-meta/<hash>.json` sidecar and travelling, on export, as a per-dataset `<name>.edits.json` beside its data file (gitignored on the same mark).

The boundary with the Pipeline is **intent, not operation**: the ops log takes manual
one-off corrections and human entry, the Pipeline takes anything expressible as a rule.
The test — *"if the source changes tomorrow, should this re-apply by itself?"*

Three constraints shaped it: row identity does not exist (ops key on the **raw ordinal**,
viable only because the raw is immutable); column ids are derived from names, so a rename
is a rekey that must repair every widget and filter referencing the old id; and the write
route **appends** rather than replacing, so two people collecting on different patients
cannot silently drop each other's work.

| St | Item | Effort |
|----|------|--------|
| 🔜 | **[TO TEST]** End to end in the app, both modes — see the plan's testing notes | M |
| 🔜 | Column drag-reorder in the table header (the `reorderColumns` op exists, the DnD does not) | S |
| 🔜 | Per-variable picker for a collection (`variableColumns` is modelled but has no UI; today every non-identity column is offered) | S |
| 💤 | Benchmark replay cost on a realistic dataset — no measurement yet of where it becomes visible | S |

## Patient data

Several patient-data dashboards per project — shipped 2026-08-17 and documented in
`docs/architecture.md`; plan retired 2026-09-03. Follow-ups that were never arbitrated:

| St | Item | Effort |
|----|------|--------|
| 🔜 | **[TO TEST]** Manual: localStorage migration, server round-trip, export→reimport→export stability | S |
| 🔜 | Pull group for patient boards (a selective pull carries them through unfiltered) | S |
| 🤔 | Data overview: surface its SQL (six mapping-driven statements, read-only first) | M |
| 🤔 | Timeline: points + bars alongside the signal — spike dygraphs-only vs a 2nd renderer | S then M |
| 💤 | `ConceptPickerDialog` still ~950 lines with its own `useReactTable` | M |

## Descriptive table & statistical tests

The rework shipped (renamed *Descriptive table*, bespoke `PublicationTable` shared by
statistical tests / regression / Kaplan-Meier, `auto` data-driven via Shapiro-Wilk,
booktabs/PNG/clipboard export, server parity). Plan retired 2026-09-03.

| St | Item | Effort |
|----|------|--------|
| 🔜 | p-value column when a group-by is active (`render/table1.py` emits none today — client + server + parity test) | M |
| 🔜 | The tooltip behind it: test, why it was chosen, statistic, warning marker (SAMPL: never a p without its test) | S |
| 🤔 | Stratified mode (a second grouping nested under the first) — deferred until asked for | M |

## Default data & catalog

Both efforts shipped and their plans are retired (2026-09-03). The default data is one
published workspace (`linkr-public-content/workspaces/demo-workspace`) whose children are
git links, installed through the catalog in server mode and baked into the seed at build
time for WASM (`npm run data:fetch`). Catalog app side is complete and the
`linkr-catalog` repo exists.

| St | Item | Effort |
|----|------|--------|
| 🔜 | Wire `data:fetch` into CI (before `vite build`, cache `.cache/default-data/`), and move `linkr-portal`'s `build.sh` onto the shared indexer | S/M |
| 🔜 | **[TO TEST]** Wizard end to end on a *virgin* instance (`LINKR_DATA_DIR=/tmp/…`): install → children cloned → decision recorded → no browser re-seed on a second machine | S |
| 🔜 | Stop auto-creating schema presets (workspace-store + seed-loader) | M |
| 🐛 | App builds `omop-5.3` from the **5.4 DDL** (spread inherits `ddl`); correct DDL now in the repo, fixed for free by the item above | S |
| 🔜 | git-lfs in the API image + test that a cloned Parquet is data, not an LFS pointer | S |
| 🔜 | Import dialog third tab ("from default data"), client-only half, on a shared catalog card/install component | M |
| 💤 | "Propose to catalog" prefill | S |

## Authoring outside Linkr (MCP)

`packages/linkr-format` (schemas + validator) and `packages/linkr-mcp` shipped; as-built in
`docs/architecture.md` § Format package & MCP authoring. Plan retired 2026-09-03. The MCP
creates and appends well but has **no update/move/remove and cannot read a tree back**, so
an agent asked to *modify* an entity falls back to `Read`/`Edit` on the JSON — which the
skill forbids and which breaks entities (keys and ids are derived).

| St | Item | Effort |
|----|------|--------|
| 🔜 | `validate` in the `linkr-public-content` CI — the CLI detects the kind, so one command covers a mixed repo | S |
| 🔜 | Spec passthrough + round-trip gate — the 8 dashboard fields + filter `scope` the authoring spec cannot express; prerequisite, else every read-modify-write silently drops them | M |
| 🔜 | Read-back: `read_entity`, `read_file`, `describe_tree` with configs | M |
| 🔜 | `update_project`, `update_widget`, `update_script` — the cheap, common edits | S |
| 🔜 | Move/rename cascades + `format/rekey.ts`: a tab key is `slug(name)` and a widget key embeds its position, so a rename orphans every reference unless keys are recomputed in the same call | M |
| 🔜 | `remove_*`, each naming its collateral damage before acting | M |
| 🔜 | Skill matrix: stop implicitly sanctioning a fallback to `Edit` | S |
| 💤 | Granular edit tools for the 6 standalone kinds | L |

## Export format harmonization

Every entity writes `entity.json`, declares its `type`, and opens with the same five
identity keys; readers stay tolerant of the old names. Shipped 2026-08-26, as-built in
`docs/architecture.md` § Export format. Plan retired 2026-09-03.

| St | Item | Effort |
|----|------|--------|
| 🔜 | Sibling repos: portal build/sync + its skill, catalog `MARKERS` + CI | M |
| 🔜 | User docs in `../linkr-website` | S |

## OMOP C/CR migration

**Built and manually validated** (2026-08-11): a mapping project's alignments are
CONCEPT + CONCEPT_RELATIONSHIP (`Maps to`, 2-billion local concepts); STCM is
*derived* from them, never built alongside. **C/CR is now the default** — for new
pipelines and for the export tabs. A pipeline that already holds STCM artefacts keeps
generating STCM (detected from its files, not a stored flag), and the seed loader pins
`stcm` so the bundled MIMIC-IV never re-shapes itself. As-built in
`docs/architecture.md` (OMOP CDM Patterns).

| St | Item | Effort |
|----|------|--------|
| 🔜 | User docs in `../linkr-website` (`docs/concept-mapping/export.mdx`, FR + EN, and the `CmExportFormatCard` frame) | S |
| 💤 | Convert the bundled MIMIC-IV ETL to C/CR (would need its `2x_map_*.sql` scripts reviewed — they join `source_to_concept_map`) | M |
| 💤 | `00b_custom_vocabulary.sql`: no ETL generates it (seed-loader only) — remove? | S |

## Permissions

The model is implemented and its surface coverage verified (2026-07-12); as-built in
`docs/architecture.md` § Permissions Model. Audit doc retired 2026-09-03.

| St | Item | Effort |
|----|------|--------|
| 🤔 | PO end-to-end validation of the resources × actions catalogue: which blocks, at which level, which default roles, and the edge cases (shared resources, project role `none`, workspace→project inheritance) | S (review) |
| 💤 | Group-access rework bucket: `workspace_id is None → no check` pattern + `update_project` destination-workspace check | M |
| 💤 | Minors: inline gating by context, organizations read open to all, test-connection SSRF | S–M |

## Other backlog items

| St | Item | Effort |
|----|------|--------|
| 💤 | ETL `source.` / `target.` role aliases in generated SQL, so scripts stop naming `ds_<alias>` and survive a round trip. Needs cross-schema support in server mode | L |

## Code quality leftovers (from REVIEW-LOG)

| St | Item | Effort |
|----|------|--------|
| 🔜 | Split entity-io.ts (~2.5k lines → export/import/clone); seed-loader.ts / WorkspacesPage.tsx also > 800 | M |
| 🤔 | Regenerate the bundled activity-dashboard seed (still uses legacy `col-N` ids) → then drop the colIdMap rescue in entity-io | S |
| 🤔 | Cohort schema migrations v1→v4: removable once no old cohort persists in your DB/IDB | S |
| 💤 | git-content-retry: token input/hint on auth-gated failure | S |
| 💤 | PTY idle sweep (kernel sessions sweep; PTY is bounded by WS lifetime) | S |
| 🔜 | Seed loader: read `LICENSE.md` (and the entity docs) from the bundled default data | S |
| 🔜 | Plugins: import via Git. Every other entity goes through the shared `ImportSourceDialog` (ZIP + clone-from-Git tabs); `PluginsTab.tsx:466` is the last bare `<input type="file">`. Plugins already push/pull via `EntityVersioningDialog`, so only the import path is missing | S |

## User documentation (website) — [website-docs-plan.md](website-docs-plan.md)

Audited 2026-09-20. `/docs` on linkr-website is **47 % placeholder**: 20 of its 43 pages
are 17-line `<DraftPage>` stubs, so the sidebar promises nine sections and delivers four.
The nav also mirrors nothing — `preparing-data` / `exploring-analyzing` map onto neither
the app's three levels nor each other, and two "gateway" pages duplicate a whole section
each. Entities shipping today with no page at all: SQL collections, data catalog, wiki,
plugins, reports, setup wizard, community catalog, organizations, patient-data boards,
dataset editing.

Planned efforts get **dedicated pages with a `<PlannedFeature>` banner** that shows what is
coming (agents, skills, reports, IDE web apps, datamarts, SPC and survey widgets) — user-visible
behaviour only, never architecture.

| St | Item | Effort |
|----|------|--------|
| 🔜 | Dead links (`/docs/more/plugins`, `/docs/presenting/reports`), retire the 2 gateway pages, fix linkr-website's stale `CLAUDE.md` | S |
| 🤔 | Restructure the nav to mirror the app's three levels, or keep the task-oriented split? | S (decision) |
| 🤔 | Stubs we will not write this pass: keep `<DraftPage>`, or flip to `wip: true` (non-clickable, honest sidebar)? | S (decision) |
| 🔜 | `<PlannedFeature>` component + the `agents` and `reports` pages | M |
| 🔜 | The 19 ships-today pages: databases → datasets → cohorts → patient-data → ide → versioning → wiki first | L |
| 🔜 | Concept-mapping verification pass — 8 pages from 2026-05, four months of app change behind them (C/CR default, schema presets as entities, qualified table names) | M |
| 🔜 | Administration (4 pages, server mode) + Reference (glossary, release notes, shortcuts) | M |
| 🤔 | Release notes hand-written, or generated from tags? | S (decision) |

Closes two open README items that already point at the website: *Export format
harmonization* and *OMOP C/CR migration* (both "User docs in `../linkr-website`").

## Long-term vision — [../vision-roadmap.md](../vision-roadmap.md)

Pillars 2 (Monitoring) and 3 (Deployment) not started.

---

*Shipped & retired (as-built in `docs/architecture.md` / the code): IDE managed environments
+ jobs, dashboard widget parallel execution, dataset column-metadata sidecar, Goupile eCRF
import, README + licence per versionable entity, AI assistant server state, portable
cross-entity links (`*Ref` pointers, 2026-08-31). Plans retired 2026-09-03 with their
remaining items folded into the sections above: versioning, patient data, descriptive
table, default data, community catalog, MCP authoring, export format harmonization,
fullstack storage, permissions audit, dataset edit layer, portable entity links.*

*Reference documents, not efforts: [../health-dcat-ap.md](../health-dcat-ap.md),
[../ecrf-formats-licensing.md](../ecrf-formats-licensing.md) (eCRF format survey + the
legal review behind the importers — clean-room rule, trademark rule, synthetic fixtures).*
