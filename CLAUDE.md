# CLAUDE.md

This file provides guidance to Claude Code when working with the LinkR v2 codebase.

## Project Overview

LinkR is a healthcare data visualization and analysis platform using the OMOP Common Data Model (CDM). It provides tools for clinicians, statisticians, and data scientists to work with clinical data warehouses through an intuitive web interface.

**v2** is a full rewrite from R/Shiny to React + FastAPI, with dual deployment (static WASM frontend-only, or full-stack with Python backend).

## Repository Structure

```
linkr/
├── CLAUDE.md                     # This file
├── README.md                     # Project readme
├── LICENSE, LICENSE.md           # Licenses
├── package.json, turbo.json      # Monorepo config (Turborepo)
├── apps/
│   ├── web/                      # React frontend (Vite + TypeScript)
│   │   ├── src/
│   │   │   ├── app/              # App entry, providers, routing
│   │   │   ├── components/       # Reusable UI components
│   │   │   │   ├── ui/           # shadcn/ui components
│   │   │   │   ├── layout/       # Sidebar, Header, StatusBar
│   │   │   │   ├── editor/       # Monaco editor wrapper
│   │   │   │   ├── terminal/     # xterm.js wrapper
│   │   │   │   ├── dashboard/    # GridStack widget components
│   │   │   │   └── file-explorer/# File tree component
│   │   │   ├── features/         # Domain-specific modules
│   │   │   │   ├── home/         # Home/welcome page
│   │   │   │   ├── projects/     # Project management
│   │   │   │   │   ├── warehouse/  # Data Warehouse pages (Databases, Concepts, Data Quality, Patient Data)
│   │   │   │   │   │   └── concepts/ # Concept browser (table, detail, stats, queries)
│   │   │   │   │   ├── cohorts/    # Cohort builder (criteria, editor, card)
│   │   │   │   │   ├── lab/        # Lab pages (Datasets, IDE, Dashboards)
│   │   │   │   │   ├── data-sources/ # Data source cards, dialogs, stats (legacy, migrating to Databases)
│   │   │   │   │   ├── dashboard/  # Dashboard widgets (patient count, vitals, timeline)
│   │   │   │   │   ├── files/      # File explorer, code editor, terminal
│   │   │   │   │   └── versioning/ # Git-like versioning (history, remote, export)
│   │   │   │   ├── plugins/      # Plugin browser/management
│   │   │   │   └── settings/     # App settings
│   │   │   ├── stores/           # Zustand state stores
│   │   │   ├── hooks/            # Custom React hooks
│   │   │   ├── lib/              # Utilities (api client, i18n, cn, WASM runtimes)
│   │   │   │   ├── duckdb/      # DuckDB-WASM engine, OMOP table defs, stats
│   │   │   │   └── storage/     # IndexedDB persistence layer (idb)
│   │   │   ├── types/            # TypeScript type definitions
│   │   │   └── locales/          # i18n JSON files (en.json, fr.json)
│   │   ├── vite.config.ts
│   │   └── tailwind.config.ts
│   │
│   └── api/                      # FastAPI backend (Python) — not yet created
│       └── ...
│
├── packages/shared/              # Shared JSON schemas (plugin, project, widget)
├── docker/                       # Docker configs
└── v1/                           # Legacy R/Shiny codebase (reference only)
```

## Project Navigation Architecture

The sidebar switches between app-level and project-level navigation based on `activeProjectUid`.

### App-level navigation
- Home (`/`)
- Projects (`/projects`)
- Settings (`/settings`)

### Project-level navigation
```
📋 Summary                          /projects/:uid/summary
🔀 Pipeline                         /projects/:uid/pipeline
🏥 Data Warehouse (group)
   ├── 📊 Databases                 /projects/:uid/warehouse/databases
   ├── 🔬 Concepts                  /projects/:uid/warehouse/concepts
   ├── ✅ Data Quality              /projects/:uid/warehouse/data-quality
   ├── 👥 Cohorts                   /projects/:uid/warehouse/cohorts
   └── 🏷️ Patient Data             /projects/:uid/warehouse/patient-data
🧪 Lab (group)
   ├── 📁 Datasets                  /projects/:uid/lab/datasets
   ├── 💻 IDE                       /projects/:uid/lab/ide
   └── 📈 Dashboards               /projects/:uid/lab/dashboards
🔄 Versioning                       /projects/:uid/versioning
⚙️ Settings                         /projects/:uid/settings
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
| Frontend | React 19 + TypeScript + Vite 7 |
| UI Components | shadcn/ui (Radix + Tailwind CSS v4) |
| Data Tables | @tanstack/react-table v8 |
| State Management | Zustand (client) + TanStack Query (server) |
| Resizable Panels | Allotment |
| Code Editor | Monaco Editor (@monaco-editor/react) |
| Terminal | xterm.js |
| Backend | FastAPI (Python 3.12+) |
| ORM | SQLAlchemy 2.0 + Alembic |
| Database | PostgreSQL (prod) / SQLite (local) |
| Analytics | DuckDB (native + WASM) |
| Client Storage | IndexedDB (via idb) — projects, data sources, files, stats cache |
| Charts | Recharts 3 |
| i18n | react-i18next |
| Logging | structlog (Python) + pino (JS) |
| Monorepo | Turborepo |

## Architecture Principles

### Dual Deployment
The app supports two modes via a `queryDataSource(dataSourceId, sql)` abstraction:
- **Local mode** (standalone): React frontend only with DuckDB-WASM + Pyodide + webR, IndexedDB for persistence (no backend needed, deployable as static site on GitLab Pages, GitHub Pages, etc.)
- **Server mode**: React frontend + FastAPI backend + PostgreSQL

### UI Approach
- **Standard navigation** for non-technical users (clinicians): clean sidebar, intuitive pages, dashboard widgets
- **IDE mode** only within Lab > IDE: Monaco editor, xterm.js terminal, file explorer, resizable panels (Allotment)
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
- **components/ui/**: Generic, reusable UI components (shadcn/ui)
- **components/layout/**: App shell components (Sidebar, Header, StatusBar)
- **components/editor/**: Monaco editor wrapper
- **components/terminal/**: xterm.js wrapper
- **features/projects/warehouse/**: Data Warehouse pages (Databases, Concepts, Data Quality, Patient Data)
- **features/projects/cohorts/**: Cohort builder (criteria forms, editor dialog, cards)
- **features/projects/lab/**: Lab pages (Datasets, IDE, Dashboards) — wrappers/stubs
- **features/projects/files/**: IDE implementation (file tree, code editor, terminal)
- **features/projects/dashboard/**: Dashboard widgets

### shadcn/ui Usage (IMPORTANT)
**Before building any UI**, always check `docs/shadcn-components.md` for the list of available shadcn/ui components. Reuse existing shadcn components as much as possible instead of hand-coding with raw Tailwind. The shadcn/ui repo is cloned at `../shadcn-ui/` for reference — source components are in `apps/v4/registry/bases/radix/ui/`.

Currently installed components are in `apps/web/src/components/ui/`. To add a new one:
1. Check the source in `../shadcn-ui/apps/v4/registry/bases/radix/ui/`
2. Adapt imports to our project (use `@/lib/cn`, `@/components/ui/...`, `@/hooks/...`)
3. Replace HSL-based colors with our CSS variable system (`var(--color-*)`)
4. Place the component in `apps/web/src/components/ui/`

### State Management
- **Zustand stores** for client-side state (UI, preferences, active project)
- **TanStack Query** for server data (projects, datasets, plugins)
- Stores: `useAppStore` (projects, UI state), `useDataSourceStore` (data sources), `useCohortStore` (cohorts), `useDashboardStore` (dashboards), `useFileStore` (file editor), `useVersioningStore` (versioning)

### Path Aliases
Use `@/` prefix for imports from `src/`:
```tsx
import { cn } from '@/lib/cn'
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

Each project follows this canonical file structure. This structure is used for git versioning (isomorphic-git in local mode, real git in server mode), export/import ZIP, and separation of config (versioned) vs data (gitignored).

```
my-project/
├── project.json              # Project metadata (name, description, status, badges)
├── README.md                 # Markdown documentation
├── tasks.json                # Todos + notes
├── .gitignore                # Excludes data/, .cache/, and datasets/
│
├── databases/                # One JSON per database (connection config + schema mapping)
│   ├── mimic-iv.json
│   └── eicu.json
│
├── cohorts/                  # One JSON per cohort (criteria + metadata)
│   ├── icu-patients.json
│   └── sepsis-cohort.json
│
├── pipeline/
│   └── pipeline.json         # Full DAG (nodes + edges) — single file
│
├── scripts/                  # User code (Python, R, SQL)
│   ├── clean_data.py
│   └── analysis.R
│
├── dashboards/               # One JSON per dashboard (tabs + widgets + layouts)
│   ├── overview.json
│   └── demographics.json
│
├── attachments/              # Images/files for README (versioned in git)
│   └── screenshot.png
│
├── datasets/                 # ⚠️ GITIGNORED — raw dataset data (CSV, Parquet)
│   ├── patients.csv
│   └── labs.parquet
│
├── datasets_analyses/        # VERSIONED — analysis configs linked to datasets
│   ├── patients/             # folder name = dataset name (sans extension)
│   │   ├── _columns.json     # Column metadata
│   │   ├── table1.json       # Analysis config
│   │   └── age_dist.json
│   └── labs/
│       └── summary.json
│
├── data/                     # ⚠️ GITIGNORED — binary data (DuckDB, Parquet, CSV)
│   ├── mimic-iv.duckdb
│   ├── eicu/                 # Parquet folders
│   └── datasets/             # Pipeline-generated datasets
│
└── .cache/                   # ⚠️ GITIGNORED — temporary caches (stats, etc.)
```

### Key design decisions
- **Todos/notes** in `tasks.json` (separate from `project.json` to keep git history clean)
- **Pipeline** as single `pipeline.json` (DAG is a connected graph, splitting makes no sense)
- **Cohorts/databases/dashboards**: one file each (independent evolution, cleaner git history)
- **Datasets**: data files in `datasets/` (gitignored), analysis configs in `datasets_analyses/` (versioned). Linked by naming convention: `datasets/foo.csv` → `datasets_analyses/foo/`
- **Binary data** in `data/` (always gitignored, never in git)
- **Attachments** in `attachments/` (versioned, part of documentation)
- **IDE visibility**: entire project tree visible, with deletion warnings on structural files (`project.json`, `README.md`, `tasks.json`, `pipeline/pipeline.json`, `.gitignore`)
- **README attachments** use standard markdown paths: `![alt](attachments/filename.png)` — resolved to blob URLs at render time in local mode

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
