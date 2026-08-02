# Linkr full-stack — storage & compute (current state + backlog)

> The design/decision history of the fullstack transition (§01–§08 of the original
> document) is done and has graduated to **`docs/architecture.md`** ("Fullstack Storage &
> Compute", "Permissions Model", "Server-Owned Rendering", "Versioning (as-built)").
> This file now only tracks the **living backlog**.

## Current state (summary)

The full-stack transition is functional and deployable (Docker validated end to end).
As-built: DB/files split under `LINKR_DATA_DIR`, server DuckDB engine, datasets on disk
(immutable raw + Parquet cache), persistent R/Python kernels keyed
`(project_uid, user_id, language, session_id)`, PTY terminal streaming, zero WASM / zero
IndexedDB in server mode, server-side export builders with golden parity tests. Settled
decisions (ratified): compute placement = the mode decides, never the data; DB = truth of
metadata, disk = single source for `scripts/` + `datasets/`; shareable recomputable
caches in the shared server `stats_cache`; IndexedDB retained for front-only only.

## Backlog (unordered — PO)

- ~~**IDE — environments & job management**~~ — **DONE** (shipped & manually validated):
  real venv/packages per env (`uv`/`renv`), managed-env resolution, DB-backed jobs with a
  bounded executor + cancel, git round-trip of the env spec, streaming Run + live R flush,
  and warm-pool ephemeral runs for parallel dashboard widgets. As-built in
  `docs/architecture.md` (Fullstack section).
- **Versioning offloading** (→ `versioning-plan.md`, items 6–7): extend `serverBuildsZip`
  to the 6 remaining scopes (server builders already exist), and the bigger one —
  **server-side ZIP import** (`POST /projects/import`, `/workspaces/import`): today import
  is fully client-orchestrated (JSZip in the browser + per-entity HTTP calls), the main
  remaining heavy client path in fullstack mode.
- **Multi-user — concurrent editing**: warn if content has been modified in the meantime
  (conflict / version detection).
- **Multi-user perf**: no logical blocking (isolated kernels, async), but CPU/RAM
  contention possible on long jobs — plan a job queue + concurrency limits. uvicorn runs
  on 1 worker.
- **Pipeline**: make it actually functional.
- **Reports page**: to implement (permission `reports` already reserved in the catalogue).
- **Finishing touches**: streaming Run + real Stop/Ctrl+C and true real-time R streaming
  are **done** (see architecture.md "Terminal & streaming Run"). Remaining is cosmetic only —
  drop `render` from the `ExecuteRequest.purpose` enum/docstring (`/execute` already refuses
  it, see architecture.md "Server-Owned Rendering"); and optionally surface long code runs as
  `kind="run"` jobs in the panel.
- **Permissions**: PO end-to-end validation of the resources × actions catalogue →
  `users-authorizations-audit.md`.
