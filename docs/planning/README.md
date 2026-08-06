# Planning — session planner

Read this at the start of a session and pick. One line per remaining item.
The as-built is in `docs/architecture.md`; details for each item live in the linked plan.

**Status**: 🔜 ready to do · 🤔 needs your decision · 💤 later/maybe
**Effort**: S (< ½ day) · M (½–2 days) · L (several days)

## Versioning — [versioning-plan.md](versioning-plan.md)

| St | Item | Effort |
|----|------|--------|
| 🤔 | Pull for the 6 entity scopes + workspaces — as **pull-overwrite** (reuse `applyClonedEntity`) or drop | M |
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

## Long-term vision — [../vision-roadmap.md](../vision-roadmap.md)

Pillars 2 (Monitoring) and 3 (Deployment) not started.

---

*Shipped & retired (as-built in `docs/architecture.md` / the code): IDE managed environments
+ jobs, dashboard widget parallel execution, dataset column-metadata sidecar, Goupile eCRF
import.*

*[../health-dcat-ap.md](../health-dcat-ap.md) is a reference document, not an effort.*
