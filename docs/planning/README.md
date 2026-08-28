# Planning — session planner

Read this at the start of a session and pick. One line per remaining item.
The as-built is in `docs/architecture.md`; details for each item live in the linked plan.

**Status**: 🔜 ready to do · 🤔 needs your decision · 💤 later/maybe
**Effort**: S (< ½ day) · M (½–2 days) · L (several days)

## Versioning — [versioning-plan.md](versioning-plan.md)

Part II of that plan is the **pull redesign** (arbitrated 2026-08-12): a bidirectional
panel where pull *replaces* the push file list in place (no modal), with the same files,
diffs and cards pointing the other way. Prior art surveyed (ServiceNow *Skip Remote
Update*, SNOMED Concept Merges, Redgate; Figma as a cautionary tale). Key move: split
`synced_oid` ("I hold this content") from `reviewed_oid` ("every incoming item got a
decision") so a **partial** pull can unblock the push.

**Steps 1–8 shipped 2026-08-12** (needs manual testing against a real remote).

| St | Item | Effort |
|----|------|--------|
| ✅ | Pull 1–8: `reviewed_oid`, pull plan, inline pull mode, Details list, 4 cards, per-item decisions + Finalize, `source-concept-ids/` merge, Config dialog | L |
| 🔜 | **[TO TEST]** Manual end-to-end: partial pull → push unblocked, conflicts, LFS path | S |
| 🔜 | Pull 9. Scope generalisation — the convergence itself is **done** (project, ETL, mapping project and schema preset all pull through `PullPanel`); what remains is the tail of push-only scopes | S/M |
| 🔜 | `attachments/` pull — a pulled README can reference images that never arrive | S/M |
| 🔜 | Server-side guard: refuse `paths=None` (git add -A) on the commit-push HTTP route | S |
| 💤 | Server-side import (`POST /projects/import`, `/workspaces/import`) — last big client-offload | L |

## IDE — environments & jobs

Feature **built and manually validated** (managed uv/renv envs, multi-session, DB-backed
jobs, git round-trip, streaming Run + live R flush, warm-pool ephemeral widget runs). Plan
retired; as-built documented in `docs/architecture.md` (Fullstack section). Only this remains:

| St | Item | Effort |
|----|------|--------|
| 💤 | Optional: surface long code runs as `kind="run"` jobs in the panel (Stop + streaming already work) | S |

## Dataset edit layer — [dataset-edit-layer-plan.md](dataset-edit-layer-plan.md)

| St | Item | Effort |
|----|------|--------|
| 🤔 | Spreadsheet-style edits over immutable raw — design not yet arbitrated vs "pipeline-only transforms" (the dataset-store edit API is its unused groundwork) | L |

## Community catalog — [catalog-plan.md](catalog-plan.md)

Centralized index repo (`linkr-catalog` on framagit) listing community-published entities.
The app side is built; the index repo itself does not exist yet, so the page has nothing
to load until it does. Browsing works in static/WASM mode too (the GitLab API v4 raw route
sends `allow-origin: *`); installing stays server-mode. Catalog repos are **public only** —
every instance reading the index must be able to clone them anonymously, so the install
path passes no credentials.

| St | Item | Effort |
|----|------|--------|
| 🔜 | Create the `linkr-catalog` repo (entries/ + schema + build.mjs + GitLab CI) — **blocks [default-data-repos-plan.md](default-data-repos-plan.md)** | S |
| ✅ | `lib/catalog/` fetch + hash-diff + localStorage cache (+ unit tests) | S |
| ✅ | Rewrite `CatalogPage.tsx`: grid, toolbar, load/refresh (card opens the repo) | M |
| ✅ | Install dialog → clone → `applyClonedEntity` (workspace picker + conflict prompt) | M |
| ✅ | Custom catalog URL — Settings → Catalog tab | S |
| ✅ | Installed-state by lineageId + version badge + Update flow (workspace picked in the toolbar) | M |
| 💤 | "Propose to catalog" prefill | S |

## Default data as external repos — [default-data-repos-plan.md](default-data-repos-plan.md)

Move the bundled default data (33 MB in `apps/web/public/data/`, mostly MIMIC-IV demo
Parquet) out of this repo into one public git repo per entity — the same repos the
catalog indexes. Client-only gets them baked in at CI build time (clone → seed folder,
so Reset-all-data still restores them); server mode clones on first run; both get a
"from default data" tab in the import dialog. **Decided**: one repo per entity, Git LFS
for Parquet, and the registry + install path are the **community catalog** — no second
mechanism. So this effort now **depends on the `linkr-catalog` repo existing**. Legal
check done: MIMIC-IV demo OMOP is Open Access ODbL 1.0, redistribution is fine provided
the notices travel with the data.

| St | Item | Effort |
|----|------|--------|
**Re-scoped 2026-08-27 (plan §0)**: the default data is not a list of entities to assemble,
it is **one published workspace** (`linkr-public-content/workspaces/demo-workspace`) whose
children are git links to the per-entity repos. Installing it = installing that one catalog
entry, which the code already does end to end. The seed survives as a **build-time
projection** of the same workspace, because a WASM build has no git client. Net effect:
server mode is essentially built, and the remaining work is A→D below.

| St | Item | Effort |
|----|------|--------|
| ✅ | All design decisions taken (plan §11 + §0): install-once + upgrade via the catalog, no auto-seeded schema presets | — |
| ✅ | 4 schema repos filled + pushed (OMOP 5.4/5.3, MIMIC-IV/III) — private until the import test passes | M |
| ✅ | **`workspace` catalog type** — type, `installWorkspaceEntry`, lineage resolution, no overwrite/nesting, `cloneWorkspaceChildren` with per-child warnings | M |
| ✅ | **Import a database WITH its data** — `applyClonedEntity` reads `data/*.parquet` → files → mount; export stays data-free; LFS resolves in `clone_to_zip` | M |
| ✅ | The `linkr-catalog` repo exists, with `entries/demo-workspace.json` (lineageId, author, org) | S |
| ✅ | `workspaces/demo-workspace` published, right shape (`entity.json` + `organization.json` + `git-links.json` + pointer folders), lineage matching the catalog entry | S |
| 🔜 | **A. Complete its child set** — it links 2 projects + 4 schemas; the 2 databases, the ETL pipeline and the mapping project are unlinked, and the DQ rule set + data catalog have no repo. Then install into an empty server instance and diff against the current seed. **Unblocks everything else** | S |
| 🔜 | **B. `fetch-default-data.mjs`** + extract `seed-manifest.mjs` from the portal `build.sh` (+ unit tests) + CI wiring + clone cache keyed `<repo>@<ref>` | M |
| ✅ | **C. Setup-wizard step 3** — checkbox + one button, on the catalog's own install; `app_settings.default_data` records the decision (incl. "start empty"). The background job was dropped too: the install runs in the browser, so there is nothing to enqueue | S/M |
| ✅ | **D. Gate the browser seed in server mode** — both phases + the seed-update diff; phase 2 was the worse one (gated on "a workspace exists", so it re-seeded over a fresh catalog install) | S |
| 🔜 | **[TO TEST]** Wizard end to end on a *virgin* instance (`LINKR_DATA_DIR=/tmp/…`): install → children cloned → decision recorded → no browser re-seed on a second machine | S |
| 🔜 | **Stop auto-creating schema presets** (workspace-store + seed-loader) — lands *with* B, never before | M |
| 🐛 | App builds `omop-5.3` from the **5.4 DDL** (spread inherits `ddl`); correct DDL now in the repo, fixed for free by the item above | S |
| 🔜 | Verify `mimic-iv-demo` (source format) license page + version/DOI | S |
| 🔜 | git-lfs in the API image + test that a cloned Parquet is data, not an LFS pointer | S |
| 🔜 | Catalog schema: `git.ref` + `sizeBytes` (`bundled`/`defaultInstall` dropped — see §0.3) | S |
| 🔜 | Import dialog third tab: client-only half, on a shared catalog card/install component | M |

## Portable cross-entity links — [portable-entity-links-plan.md](portable-entity-links-plan.md)

An entity pointing at another entity exports **this instance's primary key**, and nothing
translates it back on import — so an ETL pipeline or SQL collection shared with anyone lands
pointing at rows that do not exist, and reads as "no source database". Four fields
(`sourceDataSourceId`, `targetDataSourceId`, `mappingProjectId`, `defaultDataSourceId`);
`linkedDataSourceIds` is fine, it is stripped on purpose. Verified on the real published
repos 2026-08-28. Hand-writing a `lineageId` into the repo does **not** fix it — the
consumers match on the PK, so both ends have to move. Blocks nothing, but silently degrades
every shared workspace with a pipeline, the demo one included.

| St | Item | Effort |
|----|------|--------|
| 🔜 | 1–2. Export the 4 fields as `lineageId`; resolve back to local PKs in a second import pass (after databases + mapping projects exist) | S |
| 🔜 | 3. Tests: pure resolution + an export→import→export round trip that keeps the links | S |
| 🔜 | 4. Re-export the published ETL repos so they carry lineages | S |
| 💤 | 5. `source.`/`target.` role aliases in generated SQL — different half of the problem, larger, later | L |

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
| 🔜 | Step 6: re-export the 4 published preset repos so they carry a `lineageId` | S |
| 🤔 | Open: retire the built-in `SCHEMA_PRESETS` table first? (removes 11 literal sites) | — |

## AI agents — [ai-agents-plan.md](ai-agents-plan.md)

Two tracks: CLI agents (OpenCode first) in the IDE, and a conversational copilot in
a right sidebar driving the dashboard store as tools. Shared foundation: the Skills
entity + LLM provider config, local models by default.

| St | Item | Effort |
|----|------|--------|
| 🤔 | Foundation: `skills`/`llm-config`/`agents` permissions + `LlmProvider` (Fernet key, derived `is_local`, remote-API acknowledgement, `LINKR_ALLOW_REMOTE_LLM=false`) | M |
| 🔜 | Skills entity (workspace-scoped, one entity = one skill; file tree like SQL collections) | M |
| 🔜 | Project-level skill selection (picker; export carries references, not copies) — plan §1b | M |
| 🔜 | Generated `AGENTS.md` per project (not a Skill — different unit) + user override | S |
| 🔜 | Spike: local-model tool-calling on 3 dashboard tools — de-risks the copilot | S |
| 🔜 | Track A1: generated `opencode.json` + skills → `.agents/skills/` + launch in the existing PTY | S/M |
| 🤔 | Track B: right-sidebar copilot (agent loop, dashboard tools, per-turn undo) | L |
| 💤 | Track B on Cohorts / Patient data; Track A2 structured ACP panel | L |

## Authoring outside Linkr — [mcp-authoring-plan.md](mcp-authoring-plan.md)

Create/edit Linkr content **without the app** (a project, a tab, a script, a plugin) and
guarantee it is valid. Three blocks: `packages/linkr-format` (schemas + pure constructors
+ **validator** — shared by app, MCP and CI), writers (shared layout, pluggable sink:
`fs` / JSZip / store), and a thin MCP server. Distinct from the in-app copilot, which
drives the live Zustand store and cannot be replaced by MCP. The validator does not exist
today and is the load-bearing piece; steps 1–3 pay off even if the MCP is never built.
**Ends the `build_zip.py` ↔ `entity-io.ts` duplication** and should be scheduled *with*
the "Split entity-io.ts" debt item below, not separately.

Steps 1–8 shipped. What remains is the **edit surface** (plan §7b, added 2026-08-26): the
MCP creates and appends well, but has no update/move/remove and cannot read a widget's
config or a script's content back — so an agent asked to *modify* a tree falls back to
`Read`/`Edit` on the JSON, which is what the skill forbids and what breaks entities (keys
and ids are derived, so a hand-edit diverges from what the app re-derives). Goal: every
mutation has a tool, so "never touch the files" is enforceable rather than advisory.

| St | Item | Effort |
|----|------|--------|
| ✅ | 1–2. `packages/linkr-format`: schemas + validator (shape/referential/semantic) + 40 tests + column-id parity + CLI. No dependency (not zod — it would land in the WASM bundle). Verified on 3 real trees; found a missing `appVersion` in `icu-mortality-prediction` | M |
| ✅ | 3. Validator wired into `parseProjectZip` (import + git pull), reported after a successful import via `ImportErrorDialog variant="warning"`; never blocks | S |
| ✅ | 4. `serialize/` (spec → files, no I/O) **+ `keys.ts` extracted and imported by `entity-io.ts`** — content-key derivation was the part genuinely written twice; golden test byte-identical after the swap. Routing the whole export through `serialize/` was rejected: the app writes 8 dashboard fields and a filter `scope` the authoring spec cannot express, so it would have lost data (plan §4-as-built) | M |
| ✅ | 5. `packages/linkr-mcp`: 7 tools over stdio (`write_project`, `validate_project`, `describe_tree`, `describe_entity_schema`, `add_dashboard_tab`, `add_widget`, `add_script`), 15 tests, verified end to end over real JSON-RPC. No zod — the SDK's `fromJsonSchema` takes plain JSON Schema | S/M |
| ✅ | 6–7. `linkr-authoring` skill + 6 references (`create-plugin` folded in as `plugin.md`); `create-project` → thin wrapper; `build_zip.py` and its Python format copy deleted | S |
| ✅ | 8. All entity kinds **validated** (project, sql-collection, etl-pipeline, schema-preset, dq-rule-set, data-catalog, mapping-project, cohorts) and five of them **writable** via `write_entity`. Kind detected from the tree; `mappings.json` discriminates a mapping project from a plain one. Golden fixtures + all real content-repo entities pass. Schema presets and cohorts stay validate-only | L |
| 🔜 | 9. `validate` in the `linkr-public-content` CI — now unblocked: the CLI detects the kind, so one command covers a mixed repo | S |
| 🔜 | **A. Spec passthrough + round-trip gate** (plan §7b) — the 8 dashboard fields + filter `scope` the spec cannot express; prerequisite, else every read-modify-write silently drops them | M |
| 🔜 | B. Read-back: `read_entity`, `read_file`, `describe_tree` with configs — the missing half of read-modify-write, today's reason an agent reaches for `Read`/`Edit` | M |
| 🔜 | C1/C2/C7. `update_project`, `update_widget`, `update_script` — the cheap, common edits | S |
| 🔜 | C3/C5/C6 + `format/rekey.ts`. Move/rename cascades: a tab key is `slug(name)` and a widget key embeds its position, so a rename orphans every reference unless keys are recomputed in the same call | M |
| 🔜 | C4 + D2. `remove_*`, each naming its collateral damage before acting | M |
| 🔜 | D3. Skill matrix: stop implicitly sanctioning a fallback to `Edit` | S |
| 💤 | C8 (was step 10). Granular edit tools for the 6 standalone kinds | L |
| 🤔 | Open: folder vs ZIP output, how `linkr-format` ships to the MCP, import severity | S (decision) |

## Export format harmonization — [export-format-harmonization-plan.md](export-format-harmonization-plan.md)

Each entity's export tree was written on its own day: **five naming conventions** for the
manifest (`project.json`, `_pipeline.json`, `rule-set.json`, `preset.json`…), loose files at
the root where others use folders, entities that are a flat file or a folder depending on
whether they are git-linked, and manifest fields that diverge in presence and order — a
schema preset has no `id`/`name`/`lineageId` at all, a workspace no `version`/`license`.
**Design fully settled 2026-08-26**: one `entity.json` per entity at every
depth (containers and git-link stubs included), declaring a **`type`** field that shares the
catalog's name and vocabulary; "README + LICENSE + manifest at the root, content in folders",
plus whole-repo sidecars (`organization.json`, `git-links.json`) at the workspace root; a fixed
three-block field order; the git URL authored in the linked stub with `git-links.json`
regenerated as an index; ETL and SQL collections gain a **`scripts/`** container so
`_tree.json` always sits inside the folder it describes; `_` means "sidecar", never a manifest;
no `entityId` for workspaces, no `Workspace.version`, `plugin.json` (the widget manifest) is
**not** renamed, the schema preset's `name`/`description` are promoted out of `mapping` to the
root (and removed from it — a *database's* copied mapping keeps them) while `mapping` itself
moves to a sibling `mapping.json` (**`entity.json` is metadata, not
payload** — the preset's manifest is 83% mapping today), and every identity+provenance key is always written (`null` when unset, which deletes the
Python null-popping shims). **Net model change: zero** — all export-layer. Readers stay tolerant of the old names; writers emit one format. Touches
`linkr-portal`, `linkr-catalog` and `linkr-public-content`, so those move in lockstep.
Absorbs the workspace-flat-files backlog item below and schema-preset step 5.

The survey also turned up **5 live bugs** (plan §2.2), all in workspace sections that the
golden fixtures leave completely uncovered — including a database repo that cannot be
re-imported and workspace concept sets silently dropped on export. Hence step 0.

**Steps 0–4b and 6 shipped 2026-08-26.** Every entity writes `entity.json`, declares its
`type`, and opens with the same five identity keys; every reader still accepts the name it
used before. What remains is the part that touches **published content**.

| St | Item | Effort |
|----|------|--------|
| ✅ | 0. Golden blind spot closed (6 of 12 workspace sections were untested) + the 5 divergences fixed | M |
| ✅ | 1–2. Filenames centralised in `linkr-format/layout.ts`; readers accept `entity.json` + `type` + both field orders | M |
| ✅ | 3–3b. Writers flipped (front + back, golden fixtures regenerated, stored `versionedDataFiles` marks rewritten); universal identity+provenance blocks — `lineageId` for preset + plugin **unblocks catalog update detection** | M |
| ✅ | 4. Plugins: `_plugin.json` → `entity.json`; the functional `plugin.json` keeps its name | S |
| ✅ | 6. MCP tools + `linkr-authoring` skill references | S/M |
| 🔜 | **5. Sibling repos** — portal build/sync + its skill, catalog `MARKERS` + CI, re-export public content. The only step that touches already-published repos, so it moves in lockstep with them | M |
| 🔜 | 7. User docs in `../linkr-website` (`docs/architecture.md` § Export format is written) | S |

## Descriptive table & Statistical tests — [descriptive-table-plan.md](descriptive-table-plan.md)

The rework **shipped**: renamed *Descriptive table*, bespoke `PublicationTable` (shared
by statistical tests / regression / Kaplan-Meier), `auto` now data-driven via Shapiro-Wilk
with a per-variable override, booktabs/PNG/clipboard export, server parity for both plugins.

| St | Item | Effort |
|----|------|--------|
| 🔜 | p-value column when a group-by is active (`render/table1.py` emits none today — client + server + parity test) | M |
| 🔜 | The tooltip behind it: test, why it was chosen, statistic, warning marker (SAMPL: never a p without its test) | S |
| 🤔 | Stratified mode (a second grouping nested under the first) — deferred until asked for | M |

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

## Fullstack backlog — [fullstack-storage-plan.md](fullstack-storage-plan.md)

| St | Item | Effort |
|----|------|--------|
| 🔜 | Pipeline actually functional (end-to-end transforms) | L |
| →  | Reports page — moved to its own plan, see below | L |
| 💤 | Multi-user concurrent editing (conflicts, locking) | L |
| 💤 | Job queue / multi-worker perf (uvicorn is 1 worker) | M |
| 💤 | Cosmetic: drop `render` from the `/execute` purpose docs/enum | S |

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

## Patient data — [patient-data-plan.md](patient-data-plan.md)

**Several patient-data dashboards per project**, as the Lab has several dashboards.
**Steps 1–5 shipped 2026-08-17** (needs manual testing — see the plan's §10): the
`PatientDashboard` container now sits above the tabs, state persists to the server
(`patient_dashboards`, migration `d8e9f0a1b2c3`) instead of one global `localStorage` key —
the old key is read once for migration and never written — so boards travel in the project
export and in git. Patient-data plugins became file-based under
`packages/default-plugins/patient-data/` and the hard-coded `SYSTEM_WIDGET_TYPE_MAP` is
gone. The props contracts stay separate by design (patient widgets take OMOP context, lab
ones take dataset columns/rows).

| St | Item | Effort |
|----|------|--------|
| ✅ | 1–5: `PatientDashboard` entity (IDB+API+Alembic), export/versioning with a byte-parity Python twin, full widget kebab, file-based plugins, shared concept cells | L |
| 🔜 | **[TO TEST]** Manual: localStorage migration, server round-trip, export→reimport→export stability | S |
| 🔜 | Pull group for patient boards (a selective pull carries them through unfiltered) | S |
| 🤔 | Data overview: surface its SQL (six mapping-driven statements, read-only first) — plan §10.1 | M |
| 🤔 | Timeline: points + bars alongside the signal — spike dygraphs-only vs a 2nd renderer — plan §10.2 | S then M |
| 💤 | `ConceptPickerDialog` still ~950 lines with its own `useReactTable` | M |

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

## Databases — page with tabs + datamarts — [database-page-datamarts-plan.md](database-page-datamarts-plan.md)

Replace the right-hand `DatabaseDetailSheet` with a real page (Overview / Schema /
Statistics / Datamarts / Data quality), and add **derived sub-databases**: select
patients with the cohort criteria builder, then either materialise a new
Parquet-backed `DataSource` or create a schema in the source database. The criteria
builder gets **extracted and shared**, not forked.

| St | Item | Effort |
|----|------|--------|
| 🤔 | Naming (datamart?), entity shape, and where the cohort/datamart line sits | S (decision) |
| 🔜 | Database detail **page** with tabs; the sheet is retired | M |
| 🔜 | Extract the cohort criteria builder into a shared component | M |
| 🔜 | Datamart entity + builder + provenance (parent, criteria, built-at) | L |
| 🔜 | Mode (a): materialise to a new Parquet-backed `DataSource` | M |
| 🤔 | Mode (b): create a schema in the source DB (permission + engine support) | L |
| 🤔 | Data quality tab: run a DQ rule set against a database | M |

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

## Permissions — [users-authorizations-audit.md](users-authorizations-audit.md)

| St | Item | Effort |
|----|------|--------|
| 🤔 | PO end-to-end validation of the permission model (catalogue is implemented but "not settled") | S (review) |
| 💤 | Group-access rework bucket: `workspace_id is None → no check` pattern + `update_project` destination-workspace check | M |
| 💤 | Minors: inline gating by context, organizations read open to all, test-connection SSRF | S–M |

## Code quality leftovers (from REVIEW-LOG)

| St | Item | Effort |
|----|------|--------|
| 🔜 | Split entity-io.ts (~2.5k lines → export/import/clone); seed-loader.ts / WorkspacesPage.tsx also > 800 | M |
| 🤔 | Regenerate the bundled activity-dashboard seed (still uses legacy `col-N` ids) → then drop the colIdMap rescue in entity-io | S |
| 🤔 | Cohort schema migrations v1→v4: removable once no old cohort persists in your DB/IDB | S |
| 💤 | git-content-retry: token input/hint on auth-gated failure | S |
| 💤 | PTY idle sweep (kernel sessions sweep; PTY is bounded by WS lifetime) | S |
| → | Workspace export: dq / catalogs / schemas are flat files, so their README/LICENSE only ship in a standalone entity export — move them to folders → absorbed by [export-format-harmonization-plan.md](export-format-harmonization-plan.md) step 3 | M |
| 🔜 | Seed loader: read `LICENSE.md` (and the entity docs) from the bundled default data | S |
| 🔜 | Plugins: import via Git. Every other entity goes through the shared `ImportSourceDialog` (ZIP + clone-from-Git tabs); `PluginsTab.tsx:466` is the last bare `<input type="file">`. Plugins already push/pull via `EntityVersioningDialog`, so only the import path is missing | S |

## Long-term vision — [../vision-roadmap.md](../vision-roadmap.md)

Pillars 2 (Monitoring) and 3 (Deployment) not started.

---

*Shipped & retired (as-built in `docs/architecture.md` / the code): IDE managed environments
+ jobs, dashboard widget parallel execution, dataset column-metadata sidecar, Goupile eCRF
import, README + licence per versionable entity (the two follow-ups above are all that
is left of it; user-facing docs still to write in `../linkr-website`), **AI assistant
server state** (providers + per-surface approval, bench reports, per-user conversations —
`ai-agents-server-state.md` deleted 2026-08-26, its security invariants folded into
`docs/architecture.md` § AI assistant).*

*Reference documents, not efforts: [../health-dcat-ap.md](../health-dcat-ap.md),
[../ecrf-formats-licensing.md](../ecrf-formats-licensing.md) (eCRF format survey + the
legal review behind the importers — clean-room rule, trademark rule, synthetic fixtures).*
