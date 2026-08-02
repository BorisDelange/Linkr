# Dashboard widget parallel execution

Status: **built** (2026-08-02) — needs manual testing on a live server

## Problem

Dashboard widgets that run R/Python (inline-code + script-plugin widgets) all
share **one** kernel and run **serially**:

- `executeOnServer(...)` never passes an `envId`, so it resolves to the project's
  *active session* (usually `default`). Every Python widget of a project therefore
  keys to the same kernel `(project, user, "python", "default")`.
- A `Kernel` serialises runs behind an `asyncio.Lock` (`execute_stream`). So widget
  B waits for widget A. N slow widgets = N× the wall-clock, queued.
- Worse, they **share the namespace**: `dataset`, `result`, etc. from one widget
  clobber another's, non-deterministically by arrival order.

Component (React) widgets are unaffected — they run in-browser.

## Goal

Each widget run gets its **own** ephemeral process: isolated namespace, runs in
parallel with the others, dies at the end. This mirrors the IDE "run as job"
model (`kernel.spawn_batch` → `execute_stream` → `shutdown`), which already does
fresh-process isolation.

Runs on the project's **managed env** (widget code is user code — needs the
project's packages), NOT the app interpreter (that's only for built-in renders).

## Startup cost — warm pool

A fresh process pays (a) interpreter start + (b) heavy imports (pandas/matplotlib).
To keep that off the critical path:

- **Warm pool** per `(language, project_uid, interpreter_key)`: a few pre-started
  processes that have *already* imported the heavy libs, idle, waiting.
- `acquire_warm()` hands out a ready process (spawns on-demand if the pool is
  empty), removes it from the pool; after the run the process is **discarded**
  (never reused → namespace never polluted) and the pool **refills in the
  background**.
- **Prewarm** on dashboard open (`POST /execute/prewarm {count}`) sizes the pool
  to the current tab's code-widget count (per language), so a page of N widgets
  gets N warm processes — they all run warm+parallel, not "2 warm + rest cold".
  Warming is concurrent (one cold start, not N serial). A reservation counter
  stops concurrent refills from overshooting pool_size.
- **Bounded concurrency**: an `asyncio.Semaphore` (default 8) caps simultaneous
  ephemeral runs — 30 widgets don't spawn 30 processes at once; excess queues but
  still runs in parallel up to the bound.

Ephemeral runs are NOT counted against `max_kernels_per_user` (like `spawn_batch`)
and are NOT cached — they can't leak.

### The real serialisation: built-in renders (component widgets)

Component widgets (plot-builder, table1, key-indicator…) do NOT go through
`/execute` — they call `/execute/render`, which ran on the **shared persistent
`__app__` kernel** via `_run_in_kernel`. That kernel serialises on its lock, so a
page of N component widgets rendered one-after-another. This was the actual cause
of "5s then 2s×3" on the NeoCLIP Durées tab (4 plot-builder widgets).

Fix: `render_component` now uses `kernel.run_ephemeral("python", …, environment=None)`
— a fresh app-interpreter process from the warm pool, so renders run in parallel
just like code widgets. Prewarm gained an `app_env` flag (viewer-visible → gated
at project read) so the app-interpreter pool is warmed for render-heavy pages; the
dashboard counts server-computing component widgets and prewarms that bucket.

### Two more bugs that made widgets still load serially

1. **Blocking dataset resolution.** `_dataset_preamble` called `dataset_fs.resolve_cache`
   synchronously in the async handler. On a cold cache it parses a multi-second
   CSV/XLSX, blocking the event loop → every concurrent widget request queued
   behind it. Fixed by `await asyncio.to_thread(resolve_cache, ...)`.
2. **Runs firing before the pool warmed.** Widgets fire ~immediately, before
   prewarm finishes (~1.3s), so each `acquire` saw an empty pool and cold-started
   its own process → N serial cold starts. Fixed: `acquire` waits for an in-flight
   warm (`_reserved > 0`) instead of cold-starting, so a page of N widgets pays
   ONE cold start shared across all N, then runs warm+parallel.

## Backend

- `kernel.py`:
  - `WARM_BOOTSTRAP` per language: a tiny preamble the warm process runs once at
    spawn to import pandas/numpy/matplotlib (py) / arrow/ggplot2 (r).
  - `WarmPool`: `acquire(language, project_uid, environment)` → a started Kernel;
    background top-up to `pool_size` (default 2). Keyed by
    `(language, project_uid, interpreter_key)`.
  - `run_ephemeral(...)`: semaphore-guarded; acquire warm → `execute_stream` →
    `shutdown` + trigger refill.
- `execution.py`:
  - `/execute` honours `body.ephemeral`; when set, routes to the ephemeral path
    (env resolved via `ensure_ready`/`resolve` as today).
  - `POST /execute/prewarm {projectUid, language}`: fills the pool in background;
    gated at the run permission.

## Frontend

- `executeOnServer(..., { ephemeral })` → sends `ephemeral` in the body.
- `InlineCodeWidgetRenderer` + `ScriptPluginWidget` pass `ephemeral: true`.
  (The front already launches widget runs in parallel via independent effects; the
  server lock was the bottleneck.)
- Prewarm on dashboard mount.

## Widget editor UI

- **Save / Cancel** next to Run + **Cmd/Ctrl+S** = Save. Local **draft**
  semantics: edits stay local to the editor; Save writes to the store, Cancel
  discards. (Removes today's live-persist-per-keystroke.)
- **Split preview**: Output (figures/table/html) vs **Console** (stdout/stderr),
  **edit-mode only**. On the rendered dashboard the console is never shown
  (`PluginOutputRenderer` gains a `showConsole` prop; dashboard passes false).
