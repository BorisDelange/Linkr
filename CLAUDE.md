# CLAUDE.md

This file provides guidance to Claude Code when working with the Linkr v2 codebase.

## Project Overview

Linkr is a healthcare data visualization and analysis platform. It provides tools for clinicians, statisticians, and data scientists to work with clinical data warehouses through an intuitive web interface. While OMOP CDM is the primary supported data model, Linkr is **not locked to OMOP** — the schema presets system allows working with any data model (OMOP, i2b2, FHIR-flattened, custom hospital schemas, etc.).

**v2** is a full rewrite from R/Shiny to React + FastAPI, with dual deployment (static WASM frontend-only, or full-stack with Python backend).

## Repository Structure

```
linkr/
├── CLAUDE.md                     # This file
├── README.md                     # Project readme
├── LICENSE, LICENCE-data         # Licenses
├── CODE_OF_CONDUCT.md
├── package.json, turbo.json      # Monorepo config (Turborepo)
├── docs/                         # Documentation
│   ├── vision-roadmap.md         # Long-term vision: monitoring, deployment
│   ├── shadcn-components.md      # Available shadcn/ui components
│   └── health-dcat-ap.md         # DCAT-AP specification for health data catalogs
├── apps/
│   ├── web/                      # React frontend (Vite + TypeScript)
│   │   ├── src/
│   │   │   ├── app/              # App entry (App.tsx: routing, providers, WorkspaceGuard)
│   │   │   ├── components/
│   │   │   │   ├── ui/           # shadcn/ui components (30 files)
│   │   │   │   ├── layout/       # Sidebar, Header, StatusBar
│   │   │   │   ├── editor/       # CodeEditor, MarkdownRenderer, MarkdownToolbar, CellOutput, monaco-themes
│   │   │   │   └── terminal/     # TerminalPanel (xterm.js)
│   │   │   ├── features/         # Domain-specific modules
│   │   │   │   ├── home/         # Home/welcome page
│   │   │   │   ├── catalog/      # Data catalog (stub)
│   │   │   │   ├── workspaces/   # Workspace management (list, home, settings, create)
│   │   │   │   ├── wiki/         # Wiki system (pages, editor, search, history, attachments)
│   │   │   │   ├── warehouse/    # Workspace-level warehouse (see detail below)
│   │   │   │   ├── versioning/   # App-level versioning
│   │   │   │   ├── login/        # Login page
│   │   │   │   ├── projects/     # Project management
│   │   │   │   │   ├── summary/    # Summary tabs (Overview, Readme, Tasks)
│   │   │   │   │   ├── pipeline/   # Pipeline DAG editor (React Flow)
│   │   │   │   │   ├── warehouse/  # Project warehouse pages
│   │   │   │   │   │   ├── databases/   # Database cards, import, stats dashboard
│   │   │   │   │   │   ├── concepts/    # OMOP concept browser (table, detail, stats)
│   │   │   │   │   │   ├── subsets/     # Cohort builder (criteria forms, editor, cards)
│   │   │   │   │   │   ├── cohorts/     # Cohort builder (ATLAS-style, builder, SQL, results)
│   │   │   │   │   │   └── patient-data/# Patient timeline, widgets, charts
│   │   │   │   │   ├── lab/        # Lab pages
│   │   │   │   │   │   └── datasets/    # Dataset management, analyses, code generators
│   │   │   │   │   │       └── analyses/# Built-in analysis types (Table1, KeyIndicator, PlotBuilder, etc.)
│   │   │   │   │   ├── dashboard/  # Dashboard system (react-grid-layout, widgets, renderers)
│   │   │   │   │   ├── files/      # IDE: file tree, code editor, notebooks, terminal, connections
│   │   │   │   │   └── versioning/ # Project versioning (local history, remote git, export)
│   │   │   │   └── settings/     # App settings, plugin editor, schema presets, users, organizations
│   │   │   ├── stores/           # Zustand state stores (23 stores)
│   │   │   ├── hooks/            # Custom React hooks (7 hooks)
│   │   │   ├── lib/
│   │   │   │   ├── duckdb/       # DuckDB-WASM engine, OMOP tables, stats, cohort, catalog, DQ queries
│   │   │   │   ├── runtimes/     # Pyodide + WebR execution engines + bridge + shared-fs
│   │   │   │   ├── storage/      # IndexedDB persistence layer (idb)
│   │   │   │   ├── plugins/      # Plugin system (registry, builtin widgets, default analysis plugins)
│   │   │   │   ├── schema-ddl/   # DDL definitions (OMOP 5.4, MIMIC-III, MIMIC-IV)
│   │   │   │   ├── concept-mapping/ # Concept mapping queries + export
│   │   │   │   ├── dcat-ap/      # DCAT-AP catalog vocabulary, JSON-LD, HTML export
│   │   │   │   ├── format-helpers.ts # Centralized date/gender formatting, SQL escaping (escSql)
│   │   │   │   ├── entity-io.ts  # Generic import/export for projects and plugins (ZIP)
│   │   │   │   └── sanitize.ts   # HTML sanitizer for dangerouslySetInnerHTML
│   │   │   ├── types/            # TypeScript type definitions (9 files)
│   │   │   └── locales/          # i18n JSON files (en.json, fr.json)
│   │   ├── vite.config.ts
│   │   └── tailwind.config.ts
│   │
│   └── api/                      # FastAPI backend (Python) — basic structure in place
│       ├── main.py, config.py
│       ├── core/                  # logging, database
│       ├── models/                # user, project, dataset, plugin
│       ├── api/v1/routes/         # health, projects
│       ├── services/              # execution, omop, data
│       ├── schemas/
│       └── migrations/
│
├── packages/default-plugins/     # Built-in analysis plugins (table1, plot-builder)
├── docker/                       # Docker configs (compose, Dockerfile.web, Dockerfile.api, nginx)
└── v1/                           # Legacy R/Shiny codebase (reference only)
```

## Project Navigation Architecture

The app uses a **3-level navigation hierarchy**: App → Workspace → Project. The sidebar dynamically switches context based on `activeWorkspaceId` and `activeProjectUid`.

### App-level navigation
```
🏠 Home                             /
📁 Workspaces                       /workspaces
🏪 Catalog                          /catalog              (stub — coming soon)
── footer ──
⚙️ Settings                         /settings
```

### Workspace-level navigation (`/workspaces/:wsUid/...`)
```
🏠 Home                             /workspaces/:wsUid/home
📁 Projects                         /workspaces/:wsUid/projects
📖 Wiki                             /workspaces/:wsUid/wiki
🧩 Plugins                          /workspaces/:wsUid/plugins
🏭 Warehouse (group, default open)
   ├── 📄 Schema Presets            /workspaces/:wsUid/warehouse/schemas
   ├── 📊 Databases                 /workspaces/:wsUid/warehouse/databases
   ├── 📚 Data Catalog              /workspaces/:wsUid/warehouse/catalog
   ├── ✅ Data Quality              /workspaces/:wsUid/warehouse/data-quality
   ├── ⇄ Concept Mapping           /workspaces/:wsUid/warehouse/concept-mapping
   ├── ⚙️ ETL                       /workspaces/:wsUid/warehouse/etl
   └── 📝 SQL Scripts               /workspaces/:wsUid/warehouse/sql-scripts
🌳 Versioning                       /workspaces/:wsUid/versioning
── footer ──
⚙️ Settings                         /workspaces/:wsUid/settings
```

### Project-level navigation (`/workspaces/:wsUid/projects/:uid/...`)
```
📊 Summary                          .../projects/:uid/summary
💻 IDE                              .../projects/:uid/ide
⚙️ Pipeline                         .../projects/:uid/pipeline
🏭 Data Warehouse (group, default open)
   ├── 📊 Databases                 .../projects/:uid/warehouse/databases
   ├── 📖 Concepts                  .../projects/:uid/warehouse/concepts
   ├── 👥 Cohorts                   .../projects/:uid/warehouse/cohorts
   └── 👤 Patient Data              .../projects/:uid/warehouse/patient-data
🧪 Lab (group, default open)
   ├── 📁 Datasets                  .../projects/:uid/lab/datasets
   ├── 📈 Dashboards                .../projects/:uid/lab/dashboards
   │   └── :dashboardId             .../projects/:uid/lab/dashboards/:dashboardId
   └── 📄 Reports                   .../projects/:uid/lab/reports  (stub — coming soon)
🌳 Versioning                       .../projects/:uid/versioning
⚙️ Project Settings                 .../projects/:uid/settings
```

### Data flow philosophy
- **Data Warehouse** = OMOP long-format data (one row per clinical event). Read-only access to imported databases. Concepts, cohorts, data quality checks.
- **Pipeline** = Transformations connecting warehouse data to analysis-ready datasets (long → wide format pivot, Dataiku-inspired: source data is never modified, each transform produces a new output dataset).
- **Lab** = Wide-format analytical datasets (one row per patient, one column per variable). Code editor, dashboards, statistical analyses.
- Two entry points to Lab datasets: (1) warehouse → pipeline → dataset, (2) direct import (CSV, Excel, Parquet).

### Database management (Databases page)
- Imported databases are **always read-only** (DuckDB files, Parquet folders).
- "Copy" creates a **Parquet folder** copy (never DuckDB copy — avoids write lock issues).
- Copies use DuckDB in-memory with `read_parquet()` for queries, `COPY ... TO` for persistence.
- **Active database selection**: each project has one active database (green highlight on card, persisted in `localStorage` key `linkr-active-datasources`). All warehouse pages (Concepts, Cohorts, Data Quality, Patient Data) use `getActiveSource(projectUid)` from `useDataSourceStore` with fallback to first connected mapped source.
- **Edit mode**: the Add Database dialog doubles as an edit dialog (`editingSource` prop). In edit mode, all fields are editable (engine, schema preset, import mode, files). Uploading new files replaces the old data source (remove + create). Source type (database vs FHIR) is locked after creation.
- **Storage modes**: files are either copied into IndexedDB ("Browser copy") or referenced via File System Access API handles ("Direct link", zero-copy, Chrome/Edge only). The `CurrentFilesInfo` component shows which mode is used in edit mode.
- **Statistics dashboard** (in DatabaseDetailSheet > Statistics tab): two sections:
  1. **Patients**: patient count (big number) + gender distribution (pie chart)
  2. **Visits & hospitalizations**: visit count, descriptive stats (age mean/median/range/IQR, admission/discharge date ranges, length of stay, visits per patient), age distribution histogram by gender (stacked vertical bars, sorted by age group), admission timeline (line chart)
- Stats computed by `database-stats.ts`, cached in IndexedDB (`databaseStatsCache`), auto-refresh on first view

## Commands

### Frontend Development
```bash
cd apps/web
npm install          # Install dependencies
npm run dev          # Start dev server (port 3000)
npm run build        # Production build
npm run preview      # Preview production build
```

### Backend Development
```bash
cd apps/api
pip install -e ".[dev]"                     # Install with dev deps
uvicorn app.main:app --reload --port 8000   # Start dev server
alembic upgrade head                        # Run DB migrations
```

### Monorepo (from root)
```bash
npm install          # Install all workspace deps
npm run dev:web      # Start frontend only
npm run dev:api      # Start backend only
npm run dev:all      # Start both (concurrently)
npm run build        # Build all workspaces
```

### Docker
```bash
docker compose -f docker/docker-compose.yml up       # Run full stack
docker compose -f docker/docker-compose.yml up --build  # Rebuild and run
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + TypeScript 5.9 + Vite 7 |
| UI Components | shadcn/ui (Radix + Tailwind CSS v4) |
| Data Tables | @tanstack/react-table v8 |
| State Management | Zustand 5 (client) + TanStack Query 5 (server) |
| Routing | react-router v7 |
| Resizable Panels | Allotment |
| Code Editor | Monaco Editor (@monaco-editor/react) |
| Terminal | xterm.js v6 |
| DAG Editor | @xyflow/react v12 (React Flow) |
| Dashboard Layout | react-grid-layout |
| Drag & Drop | @dnd-kit (core, sortable, modifiers) |
| Charts | Recharts 3 + dygraphs |
| Diagrams | Mermaid |
| Markdown | react-markdown + remark-gfm + remark-math + rehype-katex |
| Backend | FastAPI (Python 3.12+) |
| ORM | SQLAlchemy 2.0 + Alembic |
| Database | PostgreSQL (prod) / SQLite (local) |
| Analytics | DuckDB (native + WASM) |
| WASM Runtimes | Pyodide 0.29 + webR 0.5 |
| Client Storage | IndexedDB (via idb) — projects, data sources, files, stats cache |
| Git | Server-side only (backend git, no browser git) |
| File I/O | jszip, xlsx, papaparse |
| i18n | react-i18next |
| Icons | lucide-react |
| Monorepo | Turborepo |

## Architecture Principles

### Dual Deployment
The app supports two modes via a `queryDataSource(dataSourceId, sql)` abstraction:
- **Local mode** (standalone): React frontend only with DuckDB-WASM + Pyodide + webR, IndexedDB for persistence (no backend needed, deployable as static site on GitLab Pages, GitHub Pages, etc.)
- **Server mode**: React frontend + FastAPI backend + PostgreSQL

### UI Approach
- **Standard navigation** for non-technical users (clinicians): clean sidebar, intuitive pages, dashboard widgets
- **IDE mode** within project IDE page: Monaco editor, xterm.js terminal, file explorer, resizable panels (Allotment)
- **Notebook support**: RmdNotebook (R Markdown / Quarto `.Rmd`/`.qmd`) and IpynbNotebook (Jupyter `.ipynb`) — cell-based editing with inline outputs, markdown preview, code execution via Pyodide/webR/DuckDB
- The app should be accessible to users who do not code

### Data Architecture
- **DuckDB as unifying query layer**: all data sources mounted as DuckDB schemas (`ds_<id>`)
- **SQL pagination**: server-side via DuckDB `LIMIT/OFFSET` (not client-side virtualization)
- **OMOP CDM**: clinical tables have both `_concept_id` and `_source_concept_id` columns — always query both
- **Batch operations**: group by domain to avoid N+1 queries (e.g., batch concept counts per domain)
- **Caching**: `useRef<Map>` for per-page caches (concept stats, record counts), not Zustand stores

### Plugin System
- Plugin manifest: `plugin.json` (JSON, not XML)
- Each plugin = self-contained directory = git repo
- Files: `plugin.json`, `ui.tsx`, `server.py`, `translations.json`
- Execution: backend mode (WebSocket) or WASM mode (Pyodide/webR)

### Plugin & Project Traceability

Both plugins and projects share these metadata fields for distributed traceability:

**Organization & Catalog**
- `organization?: OrganizationInfo` — author metadata (name, location, website, email, referenceId)
- `catalogVisibility?: 'listed' | 'unlisted'` — whether the item appears in the community catalog when published to git

**Content-Addressable Identity**
- `contentHash?: string` — SHA-256 of functional content, computed automatically on save (`lib/plugin-hash.ts`)
- `version` remains a human-chosen label (semver convention); `contentHash` is the machine identity
- Hash includes: `configSchema`, `dependencies`, `component`, `runtime`, `languages`, template file contents
- Hash excludes (metadata-only): `name`, `description`, `version`, `icon`, `iconColor`, `badges`, `tags`, `category`, `organization`, `catalogVisibility`, `origin`, `parentRef`, `changelog`

**Lineage Tracking**
- `origin?: PluginOrigin` — original creator (`pluginId`, `organizationId`, `repository`)
- `parentRef?: ParentRef` — parent version this was forked from (`contentHash`, `organizationId`, `version`)
- `changelog?: ChangelogEntry[]` — human-written release notes per version, each entry linked to a `contentHash`

**Distributed fork scenario:**
```
Rennes: contentHash=aaa, origin=rennes, parent=null, v1.0.0
  → Paris fork: contentHash=bbb, origin=rennes, parent={hash:aaa, org:rennes}, v1.1.0
    → Munich fork: contentHash=ccc, origin=rennes, parent={hash:bbb, org:paris}, v1.1.0
```
Same version label (v1.1.0) but different hashes → no confusion. Lineage chain is traceable.

**Types:** defined in `types/index.ts` (`OrganizationInfo`, `CatalogVisibility`, `PluginOrigin`, `ParentRef`, `ChangelogEntry`) and used in both `AnalysisPluginManifest` and `Project`.

## Development Guidelines

### Internationalization
All user-facing text must use i18n:
```tsx
// Use translation keys
const { t } = useTranslation()
<span>{t('projects.title')}</span>

// Add keys to both locales/en.json and locales/fr.json
```

### File Naming Conventions
- **TypeScript/React files**: kebab-case (`code-editor.tsx`, `use-widget.ts`)
- **React components**: PascalCase export (`export function CodeEditor()`)
- **Python files**: snake_case (`terminal_session.py`)
- **API routes**: kebab-case URLs (`/api/v1/data-sources`)
- **Database tables**: snake_case (`widget_configs`)

### Component Organization
- **components/ui/**: Generic, reusable UI components (shadcn/ui, 30 files)
- **components/layout/**: App shell components (Sidebar, Header, StatusBar)
- **components/editor/**: CodeEditor (Monaco), MarkdownRenderer, MarkdownToolbar, CellOutput, monaco-themes
- **components/terminal/**: TerminalPanel (xterm.js)
- **features/workspaces/**: Workspace management (list, home, settings, create dialog)
- **features/wiki/**: Wiki system (page editor, tree sidebar, search, history, attachments, icon picker)
- **features/warehouse/**: Workspace-level warehouse management:
  - **warehouse/etl/**: ETL pipeline builder (script editor, vocabulary management, profiling, SQL dependency parsing)
  - **warehouse/concept-mapping/**: Concept mapping projects (mapping editor, concept sets, progress, export)
  - **warehouse/data-quality/**: Data quality rule sets (checks, results, run history, scoring, category charts)
  - **warehouse/catalog/**: Data catalog (DCAT-AP, anonymization, data tabs, export)
  - **warehouse/sql-scripts/**: SQL script files (editor, execution, list page)
  - Schema presets, ERD visualization (SchemaERD, DdlERD), app-level databases
- **features/projects/warehouse/**: Project-level warehouse pages (Databases, Concepts, Cohorts, Patient Data)
  - **warehouse/subsets/**: Cohort builder (criteria forms: age, sex, concept, period, duration)
  - **warehouse/cohorts/**: Cohort builder (ATLAS-style criteria, builder, SQL generation, results)
  - **warehouse/patient-data/**: Patient timeline, built-in widgets (summary, timeline, notes), plugin executor
- **features/projects/lab/**: Lab pages (Datasets, Dashboards, Reports)
  - **lab/datasets/**: Dataset management with built-in analyses (Table1, Key Indicator, Plot Builder), code generators
- **features/projects/files/**: IDE (file tree, code editor, RmdNotebook, IpynbNotebook, terminal, connections, environments)
- **features/projects/dashboard/**: Dashboard system (react-grid-layout, widget renderers: inline code, plugin)
- **features/projects/pipeline/**: Pipeline DAG editor (React Flow canvas, node palette, config panel)
- **features/projects/summary/**: Project overview tabs (Overview counts, Readme editor with history, Tasks)
- **features/projects/versioning/**: Git-like versioning (remote git, export — server-only in v2)
- **features/settings/**: App settings (users, organizations, plugin editor, schema presets ERD, editor settings)

### shadcn/ui Usage (IMPORTANT)
**Before building any UI**, always check `docs/shadcn-components.md` for the list of available shadcn/ui components. Reuse existing shadcn components as much as possible instead of hand-coding with raw Tailwind. The shadcn/ui repo is cloned at `../shadcn-ui/` for reference — source components are in `apps/v4/registry/bases/radix/ui/`.

Currently installed components are in `apps/web/src/components/ui/`. To add a new one:
1. Check the source in `../shadcn-ui/apps/v4/registry/bases/radix/ui/`
2. Adapt imports to our project (use `@/lib/cn`, `@/components/ui/...`, `@/hooks/...`)
3. Replace HSL-based colors with our CSS variable system (`var(--color-*)`)
4. Place the component in `apps/web/src/components/ui/`

### State Management
- **Zustand stores** for client-side state (23 stores total)
- **TanStack Query** for server data (projects, datasets, plugins)
- Core stores:
  - `useAppStore` — projects, active project/workspace, user, UI preferences, editor settings
  - `useWorkspaceStore` — workspaces (organizational containers, git remote config)
  - `useOrganizationStore` — organizations (author metadata, institutional info)
  - `useDataSourceStore` — data sources, file uploads, DuckDB mounting, schema mapping
  - `useCohortStore` — cohort definitions and results
  - `usePipelineStore` — pipeline DAG (nodes, edges, execution state)
  - `useDashboardStore` — dashboards, tabs, widgets, layout persistence
  - `useDatasetStore` — dataset files, data cache, column metadata, analyses
  - `useFileStore` — IDE file tree, content, execution state, output cache
  - `useConnectionStore` — IDE database connections
  - `usePatientChartStore` — patient selection, chart tabs, widget configs
  - `useVersioningStore` — commits, remote git, branches, export
  - `usePluginEditorStore` — plugin file editing, metadata, testing
  - `useRuntimeStore` — code execution environment state (Pyodide/WebR)
  - `useSharedFsStore` — browser File System Access API handles + shared virtual filesystem
  - `useShortcutStore` — keyboard shortcut definitions
  - `useWikiStore` — wiki pages, hierarchies, snapshots (workspace-level)
  - `useEtlStore` — ETL pipelines, files, execution results, run logs
  - `useDqStore` — data quality rule sets, checks, run history
  - `useConceptMappingStore` — concept sets, mapping projects, mappings
  - `useCatalogStore` — data catalogs, service mappings, dimension configs
  - `useSqlScriptsStore` — workspace SQL script files, execution state
  - `useWorkspaceVersioningStore` — workspace-level versioning (git remote, branches)

### Path Aliases
Use `@/` prefix for imports from `src/`:
```tsx
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app-store'
```

### OMOP CDM Patterns
- Clinical tables: `measurement`, `condition_occurrence`, `drug_exposure`, `procedure_occurrence`, `observation`
- Each has `<table>_concept_id` (standard) and `<table>_source_concept_id` (source) — always query both with OR
- Domain mapping in `concept-queries.ts`: `domainTableMap` maps domain_id → `{ table, column, sourceColumn }`
- Batch counting: `buildBatchCountQuery(domainId, conceptIds[])` uses UNION ALL for efficient counting
- Measurement domain has additional stats: distribution (min/max/mean/median/std) + histogram (DuckDB binning)

### v1 Reference
The legacy R/Shiny code is in `v1/` for reference. Key files:
- `v1/R/fct_omop_queries.R` - OMOP query engine (port to Python)
- `v1/R/fct_app_db.R` - Database schema definitions
- `v1/R/fct_code.R` - Code execution engine
- `v1/R/fct_elements.R` - Plugin/project import/export
- `v1/inst/translations/` - i18n translations to port to JSON

## Project File Structure (Canonical)

Each project follows a unified file structure: **IDE view = Export ZIP = Git repo**. The same structure is visible in the IDE (via toggle), exported in ZIP archives, and committed to git.

```
my-project/
├── project.json              # Project metadata (name, description, status, badges)
├── README.md                 # Markdown documentation
├── tasks.json                # Todos + notes
├── .gitignore                # Dynamic: excludes datasets/**/*.csv + .cache/ by default
│
├── scripts/                  # User code — ONLY editable folder in IDE
│   ├── analysis.py
│   └── exploration.Rmd
│
├── pipeline/
│   └── pipeline.json         # Full DAG (nodes + edges) — single file
│
├── databases/                # One JSON per database (connection config + schema mapping)
│   ├── mimic-iv.json
│   └── eicu.json
│
├── cohorts/                  # One JSON per cohort (criteria + metadata)
│   ├── icu-patients.json
│   └── sepsis-cohort.json
│
├── dashboards/               # One JSON per dashboard (tabs + widgets + layouts)
│   ├── overview.json
│   └── demographics.json
│
├── datasets/                 # Analysis configs (versioned) + data files (gitignored by default)
│   ├── _tree.json            # Dataset tree metadata
│   ├── patients/
│   │   ├── _columns.json     # Column metadata
│   │   ├── table1.json       # Analysis config
│   │   └── patients.csv      # Data file (gitignored by default)
│   └── labs/
│       └── summary.json
│
├── attachments/              # Images/files for README (versioned in git)
│   ├── _meta.json            # Attachment metadata
│   └── screenshot.png
│
└── .cache/                   # ⚠️ GITIGNORED
```

### Key design decisions
- **IDE = Export = Git**: unified structure, no translation between formats
- **`scripts/`** is the only folder where users can create/edit files in the IDE; all other folders are managed by their respective feature pages (Datasets, Dashboards, etc.)
- **System folders** (pipeline, databases, cohorts, dashboards, datasets, attachments) are read-only in the IDE, hidden by default (toggle to show)
- **Todos/notes** in `tasks.json` (separate from `project.json` to keep git history clean)
- **Pipeline** as single `pipeline.json` (DAG is a connected graph, splitting makes no sense)
- **Cohorts/databases/dashboards**: one file each (independent evolution, cleaner git history)
- **Datasets**: unified folder — analysis configs and data files live together in `datasets/{name}/`. Data files (CSV/Parquet) are gitignored by default; the export dialog lets users opt-in to include them
- **Attachments** in `attachments/` (versioned, part of documentation)
- **README attachments** use standard markdown paths: `![alt](attachments/filename.png)` — resolved to blob URLs at render time in local mode
- **Runtime `data/datasets/`**: the WASM runtime (Pyodide/webR) uses an in-memory `data/datasets/` path for script-generated CSV files — this is separate from the export structure

### Summary page features
- **Tabs**: Overview (entity counts), Readme (markdown editor + toolbar), Tasks (todos + notes)
- **Readme History**: snapshots stored in `Project.readmeHistory[]`, automatic on each save, preview + restore
- **Readme Attachments**: binary files in IDB table `readme_attachments`, drag & drop upload, markdown copy

## App Data Storage (Runtime)

```
~/.linkr/
├── config/settings.json, linkr.db
├── projects/{uid}/              # project.json, files/, widgets/, data/
├── plugins/{uid}/               # plugin.json, ui.tsx, server.py
├── datasets/{uid}/              # dataset.json, data/
├── vocabularies/
├── temp/
└── logs/
```

## Long-term Vision

The current focus is **Research** (warehouse, pipeline, lab). Future capabilities are documented in `docs/vision-roadmap.md`. The key principle: **design current code so it doesn't block future evolution**.

### Three use cases for Linkr
1. **Research** (current priority) — explore OMOP data, build cohorts, create datasets, run analyses, publish results
2. **Monitoring / Pilotage** (next) — live dashboards for hospital services (quality indicators, adverse events, operational KPIs), scheduled refresh, alerts
3. **AI Deployment / CDSS** (long term, TBD) — model registry, serving, prediction logging, drift monitoring, audit trail for regulatory compliance (EU MDR, FDA)

### Workspaces (implemented)
Projects are grouped into **workspaces** (similar to GitHub Organizations / GitLab Groups). A workspace = an organizational boundary (e.g., "CHU Rennes privé", "CHU Rennes public") with shared plugins, database connections, wiki, warehouse features (ETL, concept mapping, data quality, data catalog), and a git remote. All routes are scoped to workspaces: `/workspaces/:wsUid/...`. The `useWorkspaceStore` and `useOrganizationStore` manage workspace and organization state.

### Architectural choices that preserve flexibility
- **Storage interfaces** (`lib/storage/index.ts`) abstract persistence — can switch from IndexedDB to server API without changing feature code
- **`queryDataSource()` abstraction** — local DuckDB-WASM or remote API, transparent to callers
- **Workspace-scoped data** — projects, data sources, cohorts, dashboards, wiki, warehouse features are all scoped to workspaces
- **Plugin system** — self-contained directories, shared at workspace level
- **Dashboard widget renderers** — builtin, plugin, inline code — extensible for future monitoring widgets
