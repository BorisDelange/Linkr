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
- **Pipeline** = Transforms (long → wide). Source never modified (Dataiku pattern). Each transform produces a new output dataset.
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
- Batch concept counting: `buildBatchCountQuery(domainId, conceptIds[])` — groups by domain, UNION ALL.
- Measurement extras: distribution (min/max/mean/median/std) + histogram (DuckDB binning).

## Data / Caching Patterns

- DuckDB as unifying query layer: all sources mounted as `ds_<id>` schemas.
- SQL pagination: `LIMIT/OFFSET` server-side (not client-side virtualization).
- Active database per project: `getActiveSource(projectUid)` from `useDataSourceStore`, persisted in `localStorage` key `linkr-active-datasources`.
- Page-level caches: use `useRef<Map>` (not Zustand stores) for concept stats, record counts, etc.
- Never copy a database as DuckDB — always copy as Parquet folder (avoids write lock issues).

## Fuzzy Search

See `docs/fuzzy-search.md`. All searches with typo/accent tolerance must use `buildFuzzySearchSql` from `apps/web/src/lib/fuzzy-search.ts`.
