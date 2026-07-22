# Linkr v2 — Architecture Reference

## Repository Structure

```
linkr/
├── apps/
│   ├── web/                      # React frontend (Vite + TypeScript)
│   │   └── src/
│   │       ├── app/              # App entry (App.tsx: routing, providers, WorkspaceGuard)
│   │       ├── components/
│   │       │   ├── ui/           # shadcn/ui components
│   │       │   ├── layout/       # Sidebar, Header, StatusBar
│   │       │   ├── editor/       # CodeEditor, MarkdownRenderer, MarkdownToolbar, CellOutput
│   │       │   └── terminal/     # TerminalPanel (xterm.js)
│   │       ├── features/         # Domain modules (see Component Organization below)
│   │       ├── stores/           # Zustand state stores (23 stores)
│   │       ├── hooks/            # Custom React hooks
│   │       ├── lib/
│   │       │   ├── duckdb/       # DuckDB-WASM engine, OMOP queries, stats, cohort, DQ
│   │       │   ├── runtimes/     # Pyodide + WebR execution engines + bridge + shared-fs
│   │       │   ├── storage/      # IndexedDB persistence layer (idb)
│   │       │   ├── plugins/      # Plugin system (registry, builtin widgets)
│   │       │   ├── schema-ddl/   # DDL definitions (OMOP 5.4, MIMIC-III, MIMIC-IV)
│   │       │   ├── concept-mapping/ # Concept mapping queries + export
│   │       │   ├── dcat-ap/      # DCAT-AP catalog vocabulary, JSON-LD, HTML export
│   │       │   ├── format-helpers.ts # Date/gender formatting, SQL escaping (escSql)
│   │       │   ├── entity-io.ts  # Import/export for projects and plugins (ZIP)
│   │       │   ├── fuzzy-search.ts   # Shared fuzzy search SQL helper (buildFuzzySearchSql)
│   │       │   └── sanitize.ts   # HTML sanitizer for dangerouslySetInnerHTML
│   │       ├── types/            # TypeScript type definitions
│   │       └── locales/          # i18n JSON files (en.json, fr.json)
│   └── api/                      # FastAPI backend (Python 3.12+)
│       ├── core/                 # logging, database
│       ├── models/               # user, project, dataset, plugin
│       ├── api/v1/routes/        # health, projects
│       └── services/             # execution, omop, data
├── packages/default-plugins/     # Built-in analysis plugins (table1, plot-builder)
├── docker/                       # Docker configs
├── docs/                         # Documentation
└── v1/                           # Legacy R/Shiny codebase (reference only)
```

---

## Navigation Architecture

The app uses a **3-level hierarchy**: App → Workspace → Project. The sidebar switches context based on `activeWorkspaceId` and `activeProjectUid`.

### App-level (`/`)
```
/ Home
/workspaces
/catalog  (stub)
/settings
```

### Workspace-level (`/workspaces/:wsUid/...`)
```
home, projects, wiki, plugins
warehouse/
  schemas, databases, catalog, data-quality, concept-mapping, etl, sql-scripts
versioning
settings
```

### Project-level (`/workspaces/:wsUid/projects/:uid/...`)
```
summary, ide, pipeline
warehouse/  databases, concepts, cohorts, patient-data
lab/        datasets, dashboards/:id, reports (stub)
versioning
settings
```

---

## Data Flow

- **Warehouse** = OMOP long-format, read-only. Concepts, cohorts, data quality.
- **Pipeline** = Transforms (long → wide). Source never modified. Each transform produces a new output dataset.
- **Lab** = Wide-format analytics. IDE, dashboards, statistical analyses.
- Two entry points to datasets: (1) warehouse → pipeline → dataset, (2) direct import (CSV, Excel, Parquet).

---

## Dual Deployment

Via `queryDataSource(dataSourceId, sql)` abstraction:
- **Local mode**: DuckDB-WASM + Pyodide + webR + IndexedDB (static site, no backend)
- **Server mode**: FastAPI + PostgreSQL

All data sources are mounted as DuckDB schemas (`ds_<id>`).

---

## Component Organization

```
features/
├── workspaces/        # list, home, settings, create dialog
├── wiki/              # page editor, tree sidebar, search, history, attachments
├── warehouse/         # Workspace-level warehouse:
│   ├── etl/           # ETL builder (script editor, vocabulary, profiling)
│   ├── concept-mapping/ # Mapping editor, concept sets, progress, export
│   ├── data-quality/  # Rule sets, checks, run history, scoring
│   ├── catalog/       # DCAT-AP, anonymization, export
│   └── sql-scripts/   # Editor, execution, list
├── projects/
│   ├── summary/       # Overview (entity counts), Readme editor, Tasks
│   ├── pipeline/      # React Flow DAG canvas, node palette, config panel
│   ├── files/         # IDE: file tree, Monaco, RmdNotebook, IpynbNotebook, terminal
│   ├── warehouse/     # Project-level warehouse:
│   │   ├── databases/ # Database cards, import dialog, stats dashboard
│   │   ├── concepts/  # OMOP concept browser (TanStack Table, SQL pagination)
│   │   ├── subsets/   # Cohort builder (criteria: age, sex, concept, period, duration)
│   │   ├── cohorts/   # ATLAS-style cohort builder, SQL generation, results
│   │   └── patient-data/ # Patient timeline, built-in widgets, plugin executor
│   ├── lab/
│   │   ├── datasets/  # Dataset management, Table1/KeyIndicator/PlotBuilder analyses
│   │   └── dashboard/ # react-grid-layout, widget renderers (inline code, plugin)
│   └── versioning/    # Git-like versioning (remote git, export — server only)
└── settings/          # Users, organizations, plugin editor, schema presets ERD
```

---

## State Management (Zustand Stores)

| Store | Responsibility |
|-------|---------------|
| `useAppStore` | Projects, active project/workspace, user, UI prefs, editor settings |
| `useWorkspaceStore` | Workspaces (containers, git remote config) |
| `useOrganizationStore` | Organizations (author metadata, institutional info) |
| `useDataSourceStore` | Data sources, file uploads, DuckDB mounting, schema mapping |
| `useCohortStore` | Cohort definitions and results |
| `usePipelineStore` | Pipeline DAG (nodes, edges, execution state) |
| `useDashboardStore` | Dashboards, tabs, widgets, layout persistence |
| `useDatasetStore` | Dataset files, data cache, column metadata, analyses |
| `useFileStore` | IDE file tree, content, execution state, output cache |
| `useConnectionStore` | IDE database connections |
| `usePatientChartStore` | Patient selection, chart tabs, widget configs |
| `useVersioningStore` | Commits, remote git, branches, export |
| `usePluginEditorStore` | Plugin file editing, metadata, testing |
| `useRuntimeStore` | Code execution environment state (Pyodide/WebR) |
| `useSharedFsStore` | File System Access API handles + shared virtual filesystem |
| `useShortcutStore` | Keyboard shortcut definitions |
| `useWikiStore` | Wiki pages, hierarchies, snapshots (workspace-level) |
| `useEtlStore` | ETL pipelines, files, execution results, run logs |
| `useDqStore` | Data quality rule sets, checks, run history |
| `useConceptMappingStore` | Concept sets, mapping projects, mappings |
| `useCatalogStore` | Data catalogs, service mappings, dimension configs |
| `useSqlScriptsStore` | Workspace SQL script files, execution state |
| `useWorkspaceVersioningStore` | Workspace-level versioning (git remote, branches) |

---

## Project File Structure (Canonical)

Each project: **IDE view = Export ZIP = Git repo**

```
my-project/
├── project.json              # Project metadata
├── README.md
├── tasks.json                # Todos + notes (separate from project.json for clean git history)
├── .gitignore                # Excludes datasets/**/*.csv + .cache/ by default
├── scripts/                  # User code — ONLY editable folder in IDE
├── pipeline/pipeline.json    # Full DAG (single file — DAG is a connected graph)
├── databases/                # One JSON per database (connection config + schema mapping)
├── cohorts/                  # One JSON per cohort (criteria + metadata)
├── dashboards/               # One JSON per dashboard (tabs + widgets + layouts)
├── datasets/                 # Analysis configs + data files (data gitignored by default)
│   ├── _tree.json
│   └── {name}/_columns.json, *.json analyses, *.csv data
├── attachments/              # README images (versioned); paths: attachments/filename.png
└── .cache/                   # GITIGNORED
```

System folders (pipeline, databases, cohorts, dashboards, datasets, attachments) are read-only in the IDE, hidden by default (toggle to show).

---

## Database Management

- Imported databases are **always read-only** (DuckDB files, Parquet folders).
- "Copy" creates a **Parquet folder** copy (never DuckDB copy — avoids write lock issues). Uses `read_parquet()` + `COPY ... TO`.
- **Active database**: one per project, persisted in `localStorage` key `linkr-active-datasources`. Use `getActiveSource(projectUid)` from `useDataSourceStore` (fallback to first connected mapped source).
- **Edit mode**: `editingSource` prop on Add Database dialog. New files → remove + recreate source. Source type locked after creation.
- **Storage modes**: IndexedDB copy ("Browser copy") or File System Access API handles ("Direct link", Chrome/Edge only).
- **Statistics**: `database-stats.ts`, cached in IndexedDB (`databaseStatsCache`). Sections: Patients (count + gender pie) + Visits (descriptive stats, age histogram, admission timeline).

---

## Plugin System

- Manifest: `plugin.json` (JSON, not XML). Files: `plugin.json`, `ui.tsx`, `server.py`, `translations.json`
- Each plugin = self-contained directory = git repo
- Execution: backend mode (WebSocket) or WASM mode (Pyodide/webR)

### Plugin & Project Traceability

- `contentHash` — SHA-256 of functional content, auto-computed on save (`lib/plugin-hash.ts`). Machine identity, separate from human `version` label.
- `origin` — original creator (`pluginId`, `organizationId`, `repository`)
- `parentRef` — parent version forked from (`contentHash`, `organizationId`, `version`)
- `changelog` — human-written release notes per version, each linked to a `contentHash`
- `catalogVisibility` — `'listed' | 'unlisted'` for community catalog

Types in `types/index.ts`: `OrganizationInfo`, `CatalogVisibility`, `PluginOrigin`, `ParentRef`, `ChangelogEntry`.

---

## OMOP CDM Patterns

Clinical tables: `measurement`, `condition_occurrence`, `drug_exposure`, `procedure_occurrence`, `observation`.

- Always query both `<table>_concept_id` AND `<table>_source_concept_id` (OR condition).
- Domain mapping: `domainTableMap` in `concept-queries.ts` → `{ table, column, sourceColumn }`.
- Concept counts: precomputed stats cache queried via `queryConceptCache()` (`lib/api/concept-cache.ts`); single-concept detail via `buildDomainCountQuery()` in `concept-queries.ts`.
- Measurement extras: distribution (min/max/mean/median/std) + histogram (DuckDB binning).

## Data / Caching Patterns

- DuckDB as unifying query layer: all sources mounted as `ds_<id>` schemas.
- SQL pagination: `LIMIT/OFFSET` server-side (not client-side virtualization).
- Active database per project: `getActiveSource(projectUid)` from `useDataSourceStore`, persisted in `localStorage` key `linkr-active-datasources`.
- Page-level caches: use `useRef<Map>` (not Zustand stores) for concept stats, record counts, etc.
- Never copy a database as DuckDB — always copy as Parquet folder (avoids write lock issues).

## Fuzzy Search

See `docs/fuzzy-search.md`. All searches with typo/accent tolerance must use `buildFuzzySearchSql` from `apps/web/src/lib/fuzzy-search.ts`.

---

## Fullstack Storage & Compute (as-built)

Two deployment modes; `isServerMode()` (= `!!VITE_API_URL`) decides where compute runs — **the mode alone, never the nature of the data**. Front-only (WASM) must never break.

- **DB / files split**: lightweight metadata in the database (SQLite/Postgres), heavy/binary content in files under `LINKR_DATA_DIR` (default `~/.linkr`): `linkr.db`, `_files/<sha256>` (blobs deduplicated by hash), `projects/<uid>/` (real per-project working tree: `scripts/`, `datasets/`, `.cache/datasets/` derived Parquet cache). For `scripts/` and `datasets/` **disk is the single source** (RStudio/Jupyter style); everywhere else DB = truth of the metadata, files = blobs. Recomputable shareable caches live in a shared server `stats_cache` table (reset = global invalidation).
- **Server DuckDB engine**: `queryDataSource`/`computeStats` routed to the server in fullstack mode (read-only attach, connection pool, materialized Parquet cache). Zero WASM runtime and zero IndexedDB opened in server mode (verified at the bundle level).
- **Kernels**: persistent R/Python processes keyed `(project_uid, user_id, language, env_id)`; idle eviction (`session_timeout_minutes`) + `max_sessions_per_user`; StatusBar shows Ready/Busy/RSS/PID/restart. Dataset injection is server-side (Parquet → `dataset` variable via pandas/arrow), kernel cwd = the project folder.
- **Terminal**: WebSocket `/execute/terminal` — Python/R stream over the persistent kernel (Ctrl+C → SIGINT, kernel survives), Bash = real PTY. WS auth via `?token=`.
- **Datasets**: raw files on disk are immutable; server-paginated preview/rows (`LIMIT/OFFSET`, `ORDER BY`/`WHERE`) + per-column stats as DuckDB aggregates; `datasets/` surfaced read-only in the IDE tree.
- **Server-side export builders**: in server mode the backend assembles export/versioning ZIPs itself for projects / workspaces / mapping-projects / settings, and has standalone builders for the six workspace-child scopes (`apps/api/app/services/*_export*.py`); the TS builders remain the front-only path (bypassed, never deleted). TS↔Python byte parity is pinned by **golden tests**: one frozen `expected/` extracted tree per scope, checked by a twin TS test + Python test, compared per extracted file (never zip-container bytes).

Remaining work: `docs/planning/fullstack-storage-plan.md`.

---

## Permissions Model (as-built)

- **Three tiers** — Global / Workspace / Project — over a resources × actions catalogue (`apps/api/app/core/permissions.py`): most resources carry `read/write/delete`; only `ide` adds `execute`. Global resources: `workspaces` (= create), `users`, `roles`, `organizations`, `app-database`, plus cross-cutting `all-workspaces` / `all-projects`.
- **Resolution**: global admin > project override (`project_members` — may broaden, restrict, or set `none` = project hidden) > inherited workspace role. Roles are permission bundles (viewer < editor < owner, plus custom roles).
- **Enforcement is server-side** (atomic `resource:action` checks — `require_project_permission` / `check_workspace_permission`; 403). UI gating is cosmetic only: `my-role` returns the effective permission list, the `can('resource:action')` hook disables/hides controls (front-only and admin → always true).
- **PO end-to-end validation of the catalogue is still pending** — see `docs/planning/users-authorizations-audit.md`.

---

## Server-Owned Rendering

Built-in analysis widgets never send code in server mode: the client posts `{kind, spec}` to `POST /execute/render` (spec = column names + options, structured), and the server owns one static Python program per analysis kind (`apps/api/app/services/execution/render/` — table1, correlation-matrix, map, kaplan-meier, sankey, key-indicator, regression, plot-builder, statistical-tests). Each spec is validated (pydantic per kind, unknown keys rejected). `/execute` **refuses** `purpose="render"` (`execution.py`) — free-form code always requires `ide:execute` — which closes the viewer-RCE hole. Front-only keeps computing analyses in the browser.

---

## Versioning (as-built)

- **Detection**: shared table `git_sync_state(scope, entity_id, branch, synced_oid)` anchors the last synced commit (written at push and at resolved pull; lazily adopted after an import). Behind/diverged banner wired for projects + mapping-projects; **push is refused while behind** (`pull_required`).
- **Pull, two mechanisms**: **mapping-project** = fine-grained 3-way merge (BASE = anchor, REMOTE, LOCAL = DB) at the entity level (`concept-mapping/merge.ts`, `PullResolveDialog`): mappings merged per line keyed by **source+target** (ids are regenerated on import, never used as identity), metadata per field, source-concepts and scores as whole blocks (LFS-resolved via `pull-file`). **project** = clone-based overlay: clone remote → ZIP → diff per group (dashboards/scripts/cohorts/datasets/pipeline/README) → re-apply via `importProjectContent` (insert-only, deterministic ids). A pull never makes a git commit: it writes the DB + advances the anchor; the next push reflects the merge.
- **Settings scope `account`**: organizations / users / roles versioned as a first-class GitScope (`settings_repo_getter`, `settings_export_assemble.py`) reusing the same panel UI. **Passwords are never exported**; a re-imported user without a password hash lands disabled; upsert by stable identity (username / role name / org UUID-lineageId).
- **Source-concept-id ownership**: entries belong to each mapping project (`mapping-projects/{slug}/source-concept-ids/entries.json`); the workspace root keeps only `ranges.json` (per-badge allocation). Import/seed reconstruct the registry as the union of per-project entries (root `entries.json` read only as legacy fallback) + a monotone range merge (`nextId = max`) so a stale root never regresses the allocation counter.
- **Server-side ZIP build** for projects / workspaces / mapping-projects / settings (see Fullstack section above); **instance-field stripping** for mapping projects (drop ids/timestamps/local UUIDs, stable sort, scores parquet gitignored, LFS opt-in).

Remaining work (pull for other scopes, front-only pull, stripping extension, server import): `docs/planning/versioning-plan.md`.
