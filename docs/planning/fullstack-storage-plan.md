# Linkr full-stack — storage & compute plan (database / files / server)

> Markdown version of the decision document (the original `fullstack-storage-plan.html`
> remains the historical source). **[DONE]** / **[IN PROGRESS]** / **[TODO]** annotations
> indicate the state of progress at the time of writing.

General rule: **lightweight metadata in the database**, **heavy/binary content in files**
under a single root folder (`data_dir`), modeled on `linkr-portal/`. Data-touching compute lives
**on the server side** in full-stack mode, **in the browser** in front-only mode.

---

## 01 — The DB / files split principle

The ZIP export already makes this separation (a `_tree.json` of metadata + the content files
at their path). The full-stack backend reproduces this layout on disk and indexes the
metadata in the database.

**In the database (SQLite / Postgres)**: identity & relations (id, workspaceId, projectUid, FK,
cascades); metadata (multilingual names, description, config, status, badges, timestamps,
author); file trees without content; concept mappings; dashboard structure; registries.

**In files (`data_dir`)**: code & scripts (IDE, ETL, SQL, inline widget code, plugins); data
(dataset CSV/Parquet, mapping raw source, Parquet blobs); imported databases (OHDSI
vocabularies, deduplicated by hash); markdown (README, wiki); binary attachments.

**Recomputable**: caches (`*_stats_cache`, `catalog_results`, scores) — may not be
persisted; recomputed on demand.

---

## 02 — Server persistence per entity (Task 4) **[DONE]**

Each entity previously client-only (IndexedDB) now has its server persistence: SQLAlchemy
model + Pydantic schemas (camelCase) + service + workspace/project-scoped CRUD routes +
front adapter `lib/api/<entity>.ts` wired into `createAPIStorage()`
(`api-storage.ts`). `isServerMode()` decides at the `getStorage()` façade level; the Zustand
stores are unchanged. Alembic migrations + pytest integration tests for each.

| Entity | Tables | Scope | Notes |
|---|---|---|---|
| Pipeline (project DAG) | `pipelines` | project | **[DONE]** |
| ETL pipelines | `etl_pipelines` + `etl_files` | workspace | inline script content **[DONE]** |
| Cohorts | `cohorts` | project | criteria tree JSON; result_count/attrition caches **[DONE]** |
| Data quality | `dq_rule_sets` + `dq_custom_checks` | workspace | inline SQL, cascade **[DONE]** |
| Data catalogs | `data_catalogs` | workspace | config/DCAT-AP JSON; `catalog_results` = local cache **[DONE]** |
| Concept sets | `concept_sets` | workspace | expression/resolvedIds JSON; delete-batch **[DONE]** |
| Source-concept IDs | `source_concept_id_ranges` (composite key) + `_entries` | workspace | upsert + saveBatch **[DONE]** |
| Mapping projects | `mapping_projects` + `concept_mappings` + `service_mappings` | workspace | source CSV in blob store (`raw_file_sha`, lazy-load); createBatch/deleteOrphans **[DONE]** |
| User plugins | `user_plugins` | workspace (nullable = global) | inline code files **[DONE]** |
| IDE connections | `ide_connections` | project | **Fernet secret** (password/token encrypted in `connection_secret`, never returned) **[DONE]** |
| Default schemas | (seed) | workspace | OMOP 5.4/5.3, MIMIC-IV/III seeded on workspace creation (front) **[DONE]** |

Already persisted before this task: workspaces, organizations, projects, data sources,
datasets, SQL scripts, wiki, schema presets, IDE files (other session).

Server query of a mapping project *file*: `POST /mapping-projects/{id}/query` runs the SQL
on the blob's CSV via `db_connect.query_csv` (DuckDB `read_csv_auto`), reconstructing the
`source_concepts` view (columns normalized via columnMapping, mirroring the WASM setup). **[DONE]**

Server-mode perf (concept-mapping): the CSV buffer is **never** loaded into React state
(it took the browser out of the §03 architecture and caused a devtools lag/timeout);
`mountFileSourceIntoDuckDB` is a no-op in server mode; cross-project overview parallelized
(`Promise.all`) + source-row loading deferred to the Table/Export tabs. **[DONE]**

---

## 03 — Where compute runs: architecture decision (RATIFIED)

Two deployment modes, two places for compute — **the mode alone decides, never the
nature of the data**. The `isServerMode()` flag (presence of `VITE_API_URL`) settles it.

- **Full-stack (hospital) — 100% server compute**: DuckDB, R and Python run on the
  server; WASM is not loaded. The browser sends SQL / specs and only receives
  aggregated results. Motivated by (1) low-powered workstations, (2) patient data that
  must not be exposed on the workstation.
- **Front-only (WASM) — retained**: static deployment (GitLab Pages, portal), demos,
  public data (MIMIC). Compute in the browser (DuckDB-WASM / Pyodide / WebR). Must
  **never** be broken.

No sensitivity classification. Technical boundary: everything that reads the tables
runs on the server; the browser re-renders/re-sorts already-received results.

*Later product nuance: the "no data in the browser" rule is not absolute — on a secured
workstation, we can push down a little data when it is the natural rendering (points of a
scatter plot), but we keep aggregates small when an aggregate is enough.*

**Sequencing** (the app stays usable at each step):
- **(a) Storage** — metadata in the database, blobs (dataset rows in Parquet) on disk. **[DONE]**
- **(b) Server DuckDB engine** — a query API replaces `queryDataSource` (~142 calls)
  and `computeStats`; the browser receives result rows. **[MOSTLY DONE — 2026-07-09]**
  (`isServerMode()` routing in `engine.ts`, connection pool, materialized Parquet cache;
  see the 2026-07-09 session state. Remaining: a few minor WASM leaks, see 2026-07-10.)
- **(c) Server R / Python** — per-session execution (see §06/§07). **[DONE]** (persistent
  kernels); **terminal streaming = §07(d) [DONE]**.

---

## 04 — Datasets in full-stack **[DONE]**

Target reached: rows in **Parquet** on the server (columnar, DuckDB-queryable);
`LIMIT/OFFSET` server-paginated table; `ORDER BY / WHERE` server-side sort/filters; per-column
stats = DuckDB aggregates; analyses = code run on the server, only the result comes back;
imported datasets **read-only** (immutable source, transformation via pipeline).

Chosen implementation (disk source of truth): `projects/<uid>/datasets/` holds the **raw**
files (single source, scanned from disk); a **derived Parquet cache** lives under
`projects/<uid>/.cache/datasets/` for pagination/stats/injection. Analyses are re-keyed
by `(project_uid, dataset_path)` with orphan reconciliation on scan.

The `datasets/` folder is also surfaced **read-only in the IDE tree** (next to
`scripts/`, `showInIde` flag in `use-project-tree.ts`): clicking a file opens the
**dataset viewer** (paginated preview, same rendering as the Datasets page), not the metadata
JSON; no Download or editing from the IDE (the Datasets page remains the
import/edit point, immutable source). **[DONE]**

---

## 05 — The `data_dir` root folder

A single configurable folder (`LINKR_DATA_DIR`, default `~/.linkr`) contains everything:

```
data_dir/
├─ linkr.db                    # database: metadata + relations (or external Postgres)
├─ _files/<sha256>             # shared blobs deduplicated by hash (Parquet, uploads)
└─ projects/<project-uid>/     # [DONE] real working tree per project (RStudio/Jupyter style)
   ├─ scripts/                 #   real IDE files (readable names) — disk = single source
   ├─ datasets/                #   raw datasets — disk = single source
   └─ .cache/datasets/         #   derived Parquet cache (never shown in the tree)
```

A project's kernel runs with `projects/<uid>/` as its **working directory**, so the
code reads `scripts/…` and `datasets/…` via relative paths.

---

## 06 — Running R and Python on the server side **[DONE]**

- `docker/Dockerfile.api` installs `r-base` → `Rscript` available. Python = backend interpreter.
- `app/services/execution/`: `runtime.py` (one-shot) + `kernel.py` (persistent kernels).
- Data injection by the server (`injection.py`): the Parquet is loaded as a `dataset`
  variable (pandas/pyarrow on the Python side, arrow on the R side) — no more `JSON.stringify`
  of the rows.
- Return: `RuntimeOutput` (table, encoded figures, stdout/stderr) — same contract as the
  browser WASM engine.
- Isolation: separate process, timeout, cwd = project folder.

---

## 07 — Kernel environments & sessions (IDE)

An IDE expects a **live session** where variables accumulate between runs (Jupyter kernel /
RStudio console model). Two meanings of "environment": (1) installed packages
(pip/CRAN); (2) variable state (memory of a live process).

- **(a) Persistent Python kernel per project** — variables persist. **[DONE]**
- **(b) Persistent R kernel.** **[DONE]**
- **(c) Multi-environments + sessions + monitoring.** **[DONE]** Kernels keyed
  `(project_uid, user_id, language, env_id)`; StatusBar footer (Ready/Busy/RSS/PID/restart);
  Session dropdown (create/switch/delete); `session_timeout_minutes` (idle eviction) +
  `max_sessions_per_user` enforced. **Remaining:** true venv/packages per env (today
  one env = one namespace, same interpreter); a distinct `env_id` per terminal tab.
- **(d) Server terminal = interactive REPL over a kernel (streaming)** — **the most complex,
  done last**. **[DONE]** WebSocket `/execute/terminal`: Python/R streaming over the persistent
  kernel (live stdout/stderr chunks + `done`), Ctrl+C interruption → SIGINT (the kernel survives),
  Bash = real PTY (`pty.openpty` + `bash -i`, no fork of the interpreter). WS auth via `?token=`.
  Front: `TerminalSocket` + xterm, `isServerMode()` decides (WASM unchanged in front-only).
  **Remaining (outside §07d, noted):** the editor button's Run still runs in batch (to move to streaming +
  real Stop + Ctrl+C); true real-time R streaming (today buffered by `capture.output`,
  output emitted at end of run).

Persistent in-memory kernels (ratified): one live R/Python process per environment, kept in
server-side RAM. Variables lost on server restart or on inactivity expiry
(`session_timeout_minutes`), capped by `max_sessions_per_user`. "Restart kernel" = kill +
relaunch. The footer reflects the state: Ready / Busy / Memory (RSS).

Mapping: by default 1 Python kernel + 1 R kernel per project; more can be created.
An environment = `{ language, id, project, installed packages, live process }`.

---

## 08 — Settled decisions

- **Files = source of truth or export?** → **Database = truth of the metadata; files =
  blobs**. Exception ratified since: for `scripts/` and `datasets/`, **disk IS the single
  source** (disk scan, no content mirror table), RStudio/Jupyter style.
- **Caches** → recomputable; those shareable at the project/workspace scale (database-stats,
  catalog-results) live in a **shared server cache** (`stats_cache`), invalidated by a reset
  button. (Decision refined since — see "Current state".)
- **Root folder** → `LINKR_DATA_DIR` fixed on the server side (read-only in the wizard).


---

## Current state (updated 2026-07-11)

The full-stack transition is functional and deployable (Docker validated end to end,
v2.1.0). Details per building block in sections §01–§08 above (`[DONE]` annotations).

### Done
- **Server entity storage (§02)**: all client-only entities are persisted server-side
  (metadata in the database, heavy content in blobs), dashboards included. Schemas + built-in
  plugins seeded on workspace creation.
- **Server DuckDB engine (§03b)**: `queryDataSource`/`computeStats` routed to the server in
  full-stack mode (read-only + write to Parquet only — no shared DuckDB file);
  external databases attached as `READ_ONLY`; connection pool; materialized Parquet cache.
- **Datasets (§04)**, **server R/Python (§06)**, **kernels + sessions + terminal streaming (§07)**.
- **Zero WASM runtime in server mode**: exhaustive audit — Pyodide/WebR/DuckDB-WASM are not
  loaded by any path in full-stack (concept-mapping scores, RmdNotebook, warehouse plugins
  patient-data, plugin tester: all routed to the server). Verified at the bundle level.
- **Zero IndexedDB in server mode**: stores API-backed or no-op; IDB never opened in
  full-stack. Shareable caches (`databaseStatsCache`, `catalogResults`) ported to a shared
  server table `stats_cache` (reset = global invalidation). IDB retained for front-only.
- **Lightweight client**: initial bundle ~1.9 MB → ~0.66 MB gzip (lazy-load per route + viz components
  + vis-network on demand).

### Product decisions made
- **Compute = the mode decides, never the nature of the data** (§03). Full-stack = all server;
  front-only WASM retained (static portal, MIMIC demos) — never break it.
- **Database = source of truth of the metadata; files = blobs** (§08). Exception: `scripts/` and
  `datasets/` → disk is the single source (RStudio/Jupyter style).
- **Recomputable caches**: **shared server** cache when it is shareable at the
  project/workspace scale + reset button; otherwise recompute. (Replaces the §08 note "caches not in the database".)
- **IndexedDB retained** (front-only depends on it, not a compat problem) — never opened in
  server mode.
- **Rights model**: the resources×actions catalog remains **to be validated end to end by the
  PO** (see `users-authorizations-audit.md`).

### Backlog (unordered — PO)
- **Import via git link**: verify the upload from a git link (field in each Import modal).
- **Project & workspace versioning**: Versioning page connected to a git.
- **IDE — environments**: venv/packages per env, one env per terminal (cf. §07c "remaining").
- **IDE — job management**: tracking/interruption of long processes (± job queue).
- **Multi-user — concurrent editing**: warn if content has been modified in the meantime
  (conflict / version detection).
- **Multi-user perf**: no logical blocking (isolated kernels, async), but CPU/RAM contention
  possible on long jobs — plan a job queue + concurrency limits. uvicorn runs on
  1 worker.
- **Pipeline**: make it actually functional.
- **Reports page**: to implement.
- **Finishing touches**: editor button's Run in streaming (+ Stop/Ctrl+C); true real-time R streaming
  (today buffered); inline edit/delete UI gating on the detail pages (backend already at 403).
