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
| 🔜 | Pull 9. Scope generalisation: converge Project/Etl dialogs onto the shell, then the 6 push-only scopes | M |
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
| 🔜 | Create the `linkr-catalog` repo (entries/ + schema + build.mjs + GitLab CI) | S |
| ✅ | `lib/catalog/` fetch + hash-diff + localStorage cache (+ unit tests) | S |
| ✅ | Rewrite `CatalogPage.tsx`: grid, toolbar, load/refresh (card opens the repo) | M |
| ✅ | Install dialog → clone → `applyClonedEntity` (workspace picker + conflict prompt) | M |
| ✅ | Custom catalog URL — Settings → Catalog tab | S |
| ✅ | Installed-state by lineageId + version badge + Update flow (workspace picked in the toolbar) | M |
| 💤 | "Propose to catalog" prefill | S |

## AI agents — [ai-agents-plan.md](ai-agents-plan.md)

Two tracks: CLI agents (OpenCode first) in the IDE, and a conversational copilot in
a right sidebar driving the dashboard store as tools. Shared foundation: the Skills
entity + LLM provider config, local models by default.

| St | Item | Effort |
|----|------|--------|
| 🤔 | Foundation: `skills`/`llm-config`/`agents` permissions + `LlmProvider` (Fernet key, derived `is_local`, remote-API acknowledgement, `LINKR_ALLOW_REMOTE_LLM=false`) | M |
| 🔜 | Skills entity (workspace-scoped, one entity = one skill; file tree like SQL collections) | M |
| 🔜 | Spike: local-model tool-calling on 3 dashboard tools — de-risks the copilot | S |
| 🔜 | Track A1: generated `opencode.json` + skills → `.agents/skills/` + launch in the existing PTY | S/M |
| 🤔 | Track B: right-sidebar copilot (agent loop, dashboard tools, per-turn undo) | L |
| 💤 | Track B on Cohorts / Patient data; Track A2 structured ACP panel | L |

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
Tabs, a 48-col grid, `editMode` and the shared `GenericConfigPanel` already exist — but
there is no container *above* the tabs (one surface per project), and **everything
persists to a single global `localStorage` key**, so tabs/widgets are browser-local:
absent from the project export, from the server, and from git. Patient-data plugins are
inline TS manifests bound by a hard-coded `SYSTEM_WIDGET_TYPE_MAP`, and
`packages/default-plugins/` has no `patient-data/` sibling to `analyses/`.
Arbitrated: harmonise plugin **storage/declaration**, keep the props contracts separate
(patient widgets take OMOP context, lab ones take dataset columns/rows).

| St | Item | Effort |
|----|------|--------|
| 🔜 | 1. Model + persistence (`PatientDashboard` container, storage IDB+API, model + Alembic + routes, localStorage migration) | L |
| 🔜 | 2. Export / import / versioning (derived keys + byte-parity Python twin + golden fixture) | M |
| 🔜 | 3. Widget affordances (reuse `WidgetCard` kebab: configure, duplicate, move, edit, delete) | M |
| 🔜 | 4. Plugin harmonisation (`default-plugins/patient-data/`, component runtime, drop `SYSTEM_WIDGET_TYPE_MAP`) | M |
| 🤔 | 5. Concept picker alignment + raw `conceptIds` vs concept-list references | M |

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
| 🔜 | Workspace export: dq / catalogs / schemas are flat files, so their README/LICENSE only ship in a standalone entity export — move them to folders | M |
| 🔜 | Seed loader: read `LICENSE.md` (and the entity docs) from the bundled default data | S |

## Long-term vision — [../vision-roadmap.md](../vision-roadmap.md)

Pillars 2 (Monitoring) and 3 (Deployment) not started.

---

*Shipped & retired (as-built in `docs/architecture.md` / the code): IDE managed environments
+ jobs, dashboard widget parallel execution, dataset column-metadata sidecar, Goupile eCRF
import, README + licence per versionable entity (the two follow-ups above are all that
is left of it; user-facing docs still to write in `../linkr-website`).*

*[../health-dcat-ap.md](../health-dcat-ap.md) is a reference document, not an effort.*
