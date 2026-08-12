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

### Local codes: CONCEPT / CONCEPT_RELATIONSHIP, not SOURCE_TO_CONCEPT_MAP (as-built)

A mapping project's alignments are stored the OMOP v5 way: each local code is a
**concept with an id ≥ 2 000 000 000** (`standard_concept` NULL), linked to its
standard concept by a `concept_relationship` row with `relationship_id = 'Maps to'`
(plus the reverse `'Mapped from'`). `SOURCE_TO_CONCEPT_MAP` stopped being an official
vocabulary table in CDM 5.3 and is unread by ATLAS/Achilles/DQD.

**C/CR is canonical; STCM is derived from it, never built alongside it.** The day STCM
goes, one projection function and one enum value go with it.

- `lib/concept-mapping/source-concept-ids.ts` — allocates the 2B ids, keyed on
  `(vocabulary, code)`, reusing what is stored. Ids must stay **stable**: a renumbered
  concept silently repoints data already loaded, and breaks Atlas cohorts.
- `lib/concept-mapping/ccr-export.ts` — builds `concept.csv` + `concept_relationship.csv`,
  and `stcmFromCcr()`, the STCM projection. A round-trip test holds that projection
  byte-identical to the generator it replaced.
- `concept_class_id` cascade: the source dictionary's class → the target's class →
  an echo of the domain (`Drug`→`Drug`, …, else `Observation`). Never a fixed constant.
- Deriving STCM walks the **concepts**, left-joined to the relationships — an unmapped
  code still owes STCM a `target_concept_id = 0` row, since CDM scripts join it
  unconditionally. Deriving from the relationships alone would drop every unmapped code.

The ETL Vocabulary tab picks the representation per pipeline
(`EtlVocabularyConfig.mode`: `ccr` | `ccr+stcm` | `stcm`). **C/CR is the default**;
when the mode was never chosen, the tab reads the pipeline's own files to decide —
one already holding an STCM export, or a `00_vocabulary.sql` that reads it, stays on
`stcm` so it never silently re-shapes itself. The seed loader pins `stcm` explicitly:
the bundled MIMIC-IV scripts join `source_to_concept_map`, and converting them is
separate work. Export tabs offer the three OHDSI formats behind one picker
(`lib/concept-mapping/export-formats.ts`), C/CR by default.

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
- **Storage GC** (`services/storage_gc.py`): deletion paths free their own disk (entity `delete()` → `rmtree` of the working dir + `remove_repo` of the versioning tree + `deref_blobs`), but interrupted work leaves garbage no row points at. A sweep at startup and every 6 h reclaims three kinds: abandoned chunked-upload sessions in `_tmp/` (only removed on `/uploads/{id}/complete`, so a closed tab leaks them forever), unreferenced `_files/<sha>` blobs, and `projects/<uid>/` dirs with no row. **Age is the safety property**: on-disk state is always created before the row claiming it, so entries younger than the grace period (24 h for uploads — each chunk bumps the session mtime; 1 h for blobs/project dirs) are never collected. Admin endpoints `GET /storage/gc` (dry-run preview) and `POST /storage/gc` (run now) also report *missing* blobs — shas a row points at whose file is gone, which GC can only surface, not fix.
- **Server DuckDB engine**: `queryDataSource`/`computeStats` routed to the server in fullstack mode (read-only attach, connection pool, materialized Parquet cache). Zero WASM runtime and zero IndexedDB opened in server mode (verified at the bundle level).
- **Kernels**: persistent R/Python processes keyed `(project_uid, user_id, language, session_id)` — the session id selects which live process among a user's own; the managed environment is resolved separately (below), not part of the key. Idle eviction (`session_timeout_minutes`) + `max_kernels_per_user` (old `max_sessions_per_user` env var still read as a fallback); StatusBar shows Ready/Busy/RSS/PID/restart. Dataset injection is server-side (Parquet → `dataset` variable via pandas/arrow), kernel cwd = the project folder. `_make` resolves the launch interpreter from the project's environment: the app interpreter for a `system` env, the project's managed venv / renv library for a `managed` env.
- **Environments**: one managed environment per (project, language) — `environments` table (`kind` system|managed, `status`, resolved `interpreter_path`; unique `(project_uid, language)`). The declarative spec (`environments/<lang>/`: `pyproject.toml`+`uv.lock` / `renv.lock`) lives in the project git; the materialised venv/library lives under `projects/<uid>/.cache/envs/<lang>/` (git-ignored), hardlinked/symlinked into an instance-wide shared cache (`LINKR_DATA_DIR/.cache/{uv,renv}`). Provisioning is declarative — `uv_provisioner` / `renv_provisioner` edit the manifest, re-lock, then `uv sync` / `renv::restore` off the event loop. Python via `uv`, R via `renv` (p3m repos by default). Package add/remove/upgrade + build are exposed under `/projects/{uid}/environments…` gated on `ide:read|write`; the `ServerEnvironmentsPanel` (Python + R tabs) drives them. Front-only (WASM) keeps its browser-side package install, unchanged.
- **Jobs**: long-running work (env builds, and reusable for long runs) is a DB-backed `jobs` row (`kind` build|run, `status` queued|running|done|error|cancelled, `progress`, `log_tail`), run behind a bounded in-process executor (`asyncio.Semaphore(max_build_concurrency)`, default 2 — no external broker). `/projects/{uid}/jobs` + `/jobs/{id}/cancel`; orphaned `running` jobs are reconciled to `error` at startup. Footer `JobsIndicator` polls + cancels.
- **Terminal & streaming Run**: WebSocket `/execute/terminal` — Python/R stream over the persistent kernel (Ctrl+C → SIGINT, kernel survives), Bash = real PTY. WS auth via `?token=`. The IDE Run button also streams (`streamOnServer` → live stdout/stderr in the Console tab, figures/table on `done`; Stop SIGINTs the kernel). R streams in real time: `_R_KERNEL_LOOP` evaluates one top-level expression at a time and flushes each immediately (batch/render path still returns one payload).
- **Ephemeral widget execution**: dashboard code widgets and built-in renders don't serialise on a shared kernel — each run gets its own fresh process from a **warm pool** (`WarmPool`, pre-imports pandas/matplotlib / arrow/ggplot2), semaphore-bounded (`run_ephemeral`), discarded after the run so namespaces never leak. Dashboards prewarm the pool on open (`POST /execute/prewarm`, sized to the tab's code-widget count); `/execute` honours `body.ephemeral` and `render_component` runs ephemerally on the app interpreter — so a page of N widgets runs warm and in parallel.
- **ETL runs (session per script)**: a pipeline script is sent **whole** to `WS /data-sources/{id}/etl-run-stream`; the server splits it (`db_connect._split_statements`, the twin of the client's `splitSqlStatements`), runs every statement on **one** DuckDB connection with the roles attached (`target` writable, `source`/`vocab` read-only), and streams one `{statement, index, total}` event per statement so the per-statement progress UI is unchanged. The earlier design sent one HTTP request per statement, which gave each its own connection and silently dropped session state — a `SET VARIABLE` was gone by the next statement and `query(getvariable(…))` failed with `syntax error at or near "NULL"` (front-only never had the bug: DuckDB-WASM keeps one connection per tab, so a portable script passed in the browser and failed on the server). Stop = the client closes the socket → the run task is cancelled → `run_etl` interrupts the statement and waits for DuckDB to release the target file (`EtlRunHandle`; `asyncio.to_thread` cannot be cancelled, so abandoning the await would leave the file ATTACHed). Scope is one script, not a whole run: cross-script state would need a real session lifecycle and would hold the target writable for minutes. Front-only and unmanaged targets keep the per-statement path.
- **Datasets**: raw files on disk are immutable; server-paginated preview/rows (`LIMIT/OFFSET`, `ORDER BY`/`WHERE`) + per-column stats as DuckDB aggregates; `datasets/` surfaced read-only in the IDE tree. A per-dataset sidecar `projects/<uid>/dataset-meta/<hash>.json` carries column metadata (label/description/valueLabels) + `parseOptions` (columnTypes/filterMode/delimiter), merged in `dataset_fs.resolve_cache` and travelling on export/git.
- **Server-side export builders**: in server mode the backend assembles export/versioning ZIPs itself for projects / workspaces / mapping-projects / settings, and has standalone builders for the six workspace-child scopes (`apps/api/app/services/*_export*.py`); the TS builders remain the front-only path (bypassed, never deleted). TS↔Python byte parity is pinned by **golden tests**: one frozen `expected/` extracted tree per scope, checked by a twin TS test + Python test, compared per extracted file (never zip-container bytes).

Remaining work: `docs/planning/fullstack-storage-plan.md`.

---

## Permissions Model (as-built)

- **Three tiers** — Global / Workspace / Project — over a resources × actions catalogue (`apps/api/app/core/permissions.py`): most resources carry `read/write/delete`. `execute` is split by risk: `ide:execute` = run **arbitrary** code (the RCE-sensitive one), while `patient-data`/`datasets`/`dashboards` carry a **view-time** `execute` (running a widget/analysis, not free-form code). Global resources: `workspaces` (= create), `users`, `roles`, `organizations`, `app-database`, plus cross-cutting `all-workspaces` / `all-projects`; `reports` is reserved (stub page) so roles can pre-grant.
- **Resolution**: global admin > project override (`project_members` — may broaden, restrict, or set `none` = project hidden) > inherited workspace role. Roles are permission bundles (viewer < editor < owner, plus custom roles).
- **Enforcement is server-side** (atomic `resource:action` checks — `require_project_permission` / `check_workspace_permission`; 403). UI gating is cosmetic only: `my-role` returns the effective permission list, the `can('resource:action')` hook disables/hides controls (front-only and admin → always true).
- **PO end-to-end validation of the catalogue is still pending** — see `docs/planning/users-authorizations-audit.md`.

---

## Server-Owned Rendering

Built-in analysis widgets never send code in server mode: the client posts `{kind, spec}` to `POST /execute/render` (spec = column names + options, structured), and the server owns one static Python program per analysis kind (`apps/api/app/services/execution/render/` — table1, correlation-matrix, map, kaplan-meier, sankey, key-indicator, regression, plot-builder, statistical-tests). Each spec is validated (pydantic per kind, unknown keys rejected). `/execute` **refuses** `purpose="render"` (`execution.py`) — free-form code always requires `ide:execute` — which closes the viewer-RCE hole. Front-only keeps computing analyses in the browser.

---

## Versioning (as-built)

- **Detection**: shared table `git_sync_state(scope, entity_id, branch, synced_oid)` anchors the last synced commit. It is written **only where content was actually applied** — at push, and at a pull that took everything on offer. It is never inferred: `sync_state` used to backfill it from the scratch repo's `rev-parse HEAD`, but `_sync_remote_branch` resets that shared repo to `FETCH_HEAD` on every status/diff/push, so its HEAD tracks the *remote* and the adoption persisted a sync that never happened. An entity with no anchor stays unanchored (reporting nothing is honest; claiming a sync is not). Likewise a **partial** pull does not advance it: the anchor asserts "we hold this commit's content", and moving it would clear the banner and hide the un-taken files for good. Behind/diverged banner wired for projects + mapping-projects; **push is refused while behind** (`pull_required`).
- **Pull, two mechanisms**: **mapping-project** = fine-grained 3-way merge (BASE = anchor, REMOTE, LOCAL = DB) at the entity level (`concept-mapping/merge.ts`, `PullResolveDialog`): mappings merged per line keyed by **source+target** (ids are regenerated on import, never used as identity), metadata per field, source-concepts and scores as whole blocks (LFS-resolved via `pull-file`). **project** = clone-based overlay: clone remote → ZIP → diff per group (dashboards/scripts/cohorts/datasets/pipeline/README) → re-apply via `importProjectContent` (insert-only, deterministic ids). A pull never makes a git commit: it writes the DB + advances the anchor; the next push reflects the merge.
- **Settings scope `account`**: organizations / users / roles versioned as a first-class GitScope (`settings_repo_getter`, `settings_export_assemble.py`) reusing the same panel UI. **Passwords are never exported**; a re-imported user without a password hash lands disabled; upsert by stable identity (username / role name / org UUID-lineageId).
- **Source-concept-id ownership**: entries belong to each mapping project (`mapping-projects/{slug}/source-concept-ids/entries.json`); the workspace root keeps only `ranges.json` (per-badge allocation). Import/seed reconstruct the registry as the union of per-project entries (root `entries.json` read only as legacy fallback) + a monotone range merge (`nextId = max`) so a stale root never regresses the allocation counter.
- **Server-side ZIP build** for projects / workspaces / mapping-projects / settings (see Fullstack section above); **instance-field stripping** for mapping projects (drop ids/timestamps/local UUIDs, stable sort, scores parquet gitignored, LFS opt-in).

- **Pull, as redesigned (2026-08-12)**: the panel is **bidirectional** — when the remote is ahead, the push file list and commit box are *hidden* and the same panel shows what is coming in, in both tabs (cards in Quick actions, files in Details). Four cards are shared by both directions (all / general info / mappings / source concepts), differing only in the verb ("Sync" out, "Pull" in). Two cursors, not one: `synced_oid` = "we hold this commit's content" (the 3-way base, advances only on a *complete* pull) and `reviewed_oid` = "every incoming item got an explicit decision" (what gates the push, and what `behind` is measured against). That split is what makes a *partial* pull expressible — take some items, keep your version of the rest, and the declined ones simply reappear as local changes to push. Finalizing is gated on every item having a verdict: **accepting and declining are both decisions, an untouched row is not**. Conflicts never resolve in bulk (`PullMappingsTable` for mappings, inline sub-rows for metadata fields). The pull diff is a **projection of the merge plan**, not a file diff — only candidate fields/objects are rendered, so a raw `uid`/`createdAt` never appears and a 61 925-row CSV renders as its row tally. `source-concept-ids/` is merged monotonically on every pull with no user choice (local id wins, `nextId = max`) — it was pushed but never pulled, so badge allocations diverged silently. Similarity scores are gone from the pull entirely (gitignored, so never in a repo). Code: `lib/pull-plan.ts`, `lib/concept-mapping/pull-plan-builder.ts` / `pull-diff.ts` / `pull-source-concept-ids.ts`, `components/versioning/PullPanel.tsx` + `PullFileRow` + `PullDiffDialog` + `MappingProjectPull`.

Remaining work (step 9: generalising the pull shell to the other scopes; `attachments/`): `docs/planning/versioning-plan.md`.

## Entity documentation: README / LICENSE / attachments (as-built)

Every versionable entity carries its own documentation — workspace, project, mapping project, SQL collection, ETL pipeline, DQ rule set, data catalog, schema preset, user plugin.

- **Files, not metadata.** The docs travel as real files beside the manifest so git, GitHub/GitLab and the portal render them: `README.md` (+ `README.<lang>.md` per extra language), `LICENSE.md`, and `attachments/`. The entity JSON keeps only what a file cannot express — the licence **identity** (`license: {id, name}`, the text lives in `LICENSE.md`) and `readmeLang`. One module owns the writing on each side: `lib/entity-io.ts` (`writeReadmeFiles` / `writeLicenseFile` / `licenseMeta` / `stripEntityDocs` / `writeAttachmentFiles`) and its byte-faithful port `app/services/entity_docs.py`.
- **`readmeLang`.** The suffix-free `README.md` holds the *primary* language, which is English when present and otherwise the first one — so a French-only readme lands in `README.md`. The marker names that language, and is omitted when it is English (existing exports stay byte-identical). Without it the reader assumed `en`, relabelled French content as English on import, and a pull then overwrote the real English readme.
- **One filename rule.** `README_FILE_RE` (`lib/entity-tree.ts`, twinned by `_DOCS_RE` in `git_service.py`) is the single definition of what a README file is called and which language it holds, accepting a bare (`fr`) or regional (`pt-BR`) tag. It replaced seven copies with two different grammars, which disagreed enough that `README.pt-BR.md` classified as docs but matched no reader — its content was silently dropped.
- **Reserved at the root.** `isReservedTreeName` refuses `README*.md`, `LICENSE`/`LICENCE`/`COPYING` (several spellings) and `attachments` at an entity's tree root, in every create / rename / upload path: the export writes those names from the entity's own fields, so a user file of the same name is silently overwritten. Inside a subfolder they are ordinary files.
- **Attachments are polymorphic.** `readme_attachments(owner_type, owner_id, workspace_id, …)` — one table for all nine owners, since a per-owner FK would mean nine tables. That costs the FK cascade, so each entity's delete calls `attachment_service.delete_readme_for_owner`; `workspace_id` is kept (stamped **server-side** from the resolved owner, never trusted from the client) so deleting a workspace still cascades. Authorization always re-derives the owner from the DB and maps `owner_type` through an allowlist, so an attachment is governed by its entity's own resource (an ETL pipeline's README needs `etl:*`, not `workspace-summary:*`). Blobs are content-addressed (`sha256`) and deduplicated.
- **Deterministic order.** `attachments/_meta.json` is sorted by attachment id on both sides — neither the IDB index nor a bare `SELECT` promises an order, and a mismatch is a false git diff that flips on every export.
- **Pull.** `lib/entity-docs-pull.ts` is the shared reader/comparator for all three scopes that pull selectively (project, ETL pipeline, mapping project), including `withEntityDocs`, which folds `README.md`/`LICENSE.md` back onto a manifest during a list-page import.
