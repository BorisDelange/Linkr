# Linkr IDE — Environments & Job management (design plan)

> Design document, **not yet implemented**. Scope: turn the IDE's `env_id` from a
> pure namespace label into a **real, reproducible environment** (isolated packages),
> add **multiple live sessions** per environment, and add **job management** for
> long-running executions. Server / full-stack mode only — front-only (WASM) keeps its
> browser-side package install unchanged.
>
> Decisions ratified 2026-07-12 are marked **[DECIDED]**. A second round (2026-07-30)
> **simplified the model** — one environment per language per project, distinct sessions,
> shared instance-wide package cache — and settled the open points. Those are marked
> **[DECIDED 2026-07-30]**; where they overrule the earlier text it is called out.

---

## 0 — Where we are today (current state, verified)

- **`env_id` is only a namespace label.** Kernels are keyed
  `(project_uid, user_id, language, env_id)` (`kernel.py:472`), but `_make()`
  (`kernel.py:563`) ignores `env_id` entirely: every Python kernel runs the backend's
  own `sys.executable`, every R kernel runs the system `Rscript`. Two env ids = two
  processes, **same interpreter, same packages**, differing only by in-memory globals.
- **`ExecutionSession`** (`models/execution_session.py`) = `{id, project_uid, user_id,
  name}`, `id` doubles as the kernel `env_id`. Its docstring: *"a session is a namespace,
  not a virtualenv."*
- **No environment table, no package-management endpoint, no runtime install path.**
  `EnvironmentsDialog.tsx:432-438` is a "coming soon" stub in server mode; the real
  install/uninstall logic only targets the browser WASM engines (front-only).
- **Front:** `IdeFile` (`types/index.ts:573-582`) has **no per-file metadata** beyond
  name/language/content; in server mode a file's `id` is its relative disk path. The
  session choice is **per project** (`session-store.ts` `activeByProject`, persisted in
  `localStorage`), threaded as `envId` by `executeOnServer` (`execution.ts:36-38`); the
  two IDE call sites (`FilesPage.tsx:576`, `RmdNotebook.tsx:490`) don't pass it.
- **Docker image** `rocker/r-ver` + Posit Package Manager (p3m): one shared Python venv,
  one system R library, all packages baked at build time.
- **Sessions**: `session_timeout_minutes` (idle eviction) + `max_sessions_per_user`
  enforced in `KernelManager`; StatusBar footer shows Ready/Busy/RSS/PID/restart.

The point of this plan: make `env_id` resolve to a **real interpreter + real isolated
package set**, defined **declaratively** so it can be reproduced — and let a user open
**several live sessions** on it.

---

## 1 — Ratified decisions (the frame)

- **[DECIDED 2026-07-30] One environment per language per project.** ⚠️ *Simplifies the
  earlier "several environments per project, chosen per artefact".* A project has **exactly
  one Python environment and one R environment** — the RStudio+renv / uv standard (one
  project → one `.venv`, one renv library). Rationale from the PO: no need for several
  package-version sets *within one project*; if you need isolation, use another project.
  This removes the whole per-artefact environment-selection layer (no `environmentId` on
  scripts/dashboards/datasets, no env catalogue, no derivation). The environment travels in
  the project git → open-science reproducibility, unchanged.
- **[DECIDED 2026-07-30] Environment ≠ session; multiple sessions allowed.** *Reverses the
  earlier "session and environment collapsed".* An **environment** = what runs (interpreter
  + packages), project-scoped, shared, versioned. A **session** = a live namespace over it
  (in-memory variables, one interpreter process), **per user, several allowed** — exactly
  like several terminals on one VSCode interpreter, or several notebooks on one Jupyter
  kernel. Sessions are **local & ephemeral, never exported** (live memory doesn't travel).
- **[DECIDED] Declarative definition.** An environment = a **manifest + lockfile**, both
  versioned in the project git. Isolation (own package set) + reproducibility (committed
  lock, `clone → build` reconstructs it). We never model an environment as "a process where
  installs were typed by hand".
- **[DECIDED] Python via `uv`, R via `renv`, model language-agnostic.** `uv`: cross-platform
  `uv.lock`, manages interpreters, PyPI-native, shared global cache. `renv`: private
  per-project library, `renv.lock`, global cache. Data model stores `language + manifest +
  lockfile`; the resolver picks the toolchain.
- **[DECIDED 2026-07-30] Package storage shared instance-wide.** *New.* uv and renv both
  point at a **single Linkr-wide cache** (`LINKR_DATA_DIR/.cache/uv`,
  `LINKR_DATA_DIR/.cache/renv`). A given `dplyr 1.1.4` / `pandas 2.1.4` is stored **once per
  machine**; each project's venv/library is hardlinks/symlinks into that cache — uv and renv
  do this natively, we only have to point them at a common cache dir instead of per-project
  ones. This is a *config* choice (where the caches live), not architecture.
- **[DECIDED] Internet assumed available** (no air-gapped v1). Install runs against PyPI /
  p3m; index URL / repos stay configurable → a future internal mirror is config, not
  re-architecture.
- **[DECIDED] R repos default to p3m** (`packagemanager.posit.co`), not bare CRAN — a public
  service, Docker-independent, that neutralises source-compile slowness on Linux.
- **[DECIDED] System dependencies are the machine/image's responsibility.** Same boundary as
  an RStudio container: R *packages* → renv (runtime); *system libs* (GDAL, libxml2…) →
  baked in the image (Docker) or by the host admin (non-Docker). Linkr **diagnoses** a
  missing system dep (actionable message, optionally via Posit `r-system-requirements`) but
  never `apt install`s it.

### Docker vs non-Docker (explicit, because deployments are often non-Docker)

| | **Docker** (recommended) | **Non-Docker** (server / personal PC) |
|---|---|---|
| System deps | Baked in `rocker/r-ver` image — guaranteed | Host admin's responsibility (like native RStudio Server) |
| R binaries | p3m repo (fast) | p3m on Linux server; CRAN native binaries on macOS/Windows |
| Python | `uv` provisions the venv under `data_dir` | same — `uv` is self-contained |
| Package cache | shared Linkr-wide cache under `LINKR_DATA_DIR/.cache` (volume-mount to persist) | same shared cache dir; persists on the host |
| Interpreter discovery | fixed paths | **config + autodetect** (where are Rscript / uv / caches) |

The model is identical in both; only *interpreter/cache discovery* and *who provides
system libs* differ. Both captured as server config with autodetection.

---

## 2 — Data model

### 2a. `environments` table (new)

One row per (project, language). At most two rows per project (one `python`, one `r`).

| Column | Type | Note |
|---|---|---|
| `id` | uuid PK | server-local id used in the kernel key |
| `project_uid` | FK projects, CASCADE | scope |
| `language` | enum `python` \| `r` | one row per language per project (unique constraint on `(project_uid, language)`) |
| `kind` | enum `system` \| `managed` | `system` = the already-installed interpreter/library (no build, runs immediately — the seeded default); `managed` = uv/renv resolves it from the committed manifest+lock |
| `status` | enum `draft`\|`building`\|`ready`\|`error` | last provision result; `system` is always `ready` |
| `interpreter_path` | str? | resolved venv python / renv library root — **server-computed, machine-local, NOT in git** |
| timestamps | | |

- **No `name`, no `derived_from_id`, no `manifest_path` column.** There is one env per
  language, so its manifest path is fixed: `environments/python/` or `environments/r/`.
  Derivation is gone (single env → nothing to derive from).
- The **manifest + lockfile live on disk in the project git** (source of truth); the row is
  the DB-side index (`status`, resolved `interpreter_path`). Mirrors the storage-plan rule
  *disk is the single source for `scripts/` and `datasets/`* — environments join that list.
- `interpreter_path` / `status` are **recomputable**, never committed (a venv path on
  machine A is meaningless on machine B).

### 2b. On-disk layout (extends the storage plan)

```
projects/<uid>/
├─ scripts/
├─ datasets/
├─ environments/                     # [NEW] versioned in the project git
│  ├─ python/  pyproject.toml + uv.lock
│  └─ r/       renv.lock + .Rprofile
└─ .cache/
   └─ envs/                          # [NEW] resolved venv / renv library — NEVER in git
      ├─ python/                     #   → hardlinks into the shared uv cache
      └─ r/                          #   → symlinks into the shared renv cache

LINKR_DATA_DIR/.cache/               # [NEW] shared, instance-wide package store
├─ uv/                               #   one copy of each (package, version) for ALL projects
└─ renv/
```

- `environments/{python,r}/` = the **declarative spec** (committed).
- `projects/<uid>/.cache/envs/{python,r}/` = the **materialised** venv / renv library for
  that project — machine-local, git-ignored, made of links into the shared cache.
- `LINKR_DATA_DIR/.cache/{uv,renv}` = the **shared package store**; a version is on disk
  once, every project links to it (§1 shared-cache decision).

### 2c. `ExecutionSession` — kept as the SESSION record

Repurposed from "namespace = env id" to a real **session** row:
`{id, project_uid, user_id, language, name}`. Several rows per (project, user, language) —
"Session 1", "Session 2"… A `"1"` default session always exists implicitly so the user
needn't think about it. Its route family (`/execute/sessions*`) stays; delete kills that
session's kernel.

**Kernel key grows by one dimension** —
`(project_uid, user_id, language, session_id)` — was
`(project_uid, user_id, language, env_id)` at `kernel.py:472`. There is exactly one
environment per (project, language), so the environment is *implied* by
`(project_uid, language)` and need not be in the key; `session_id` selects the live process.
Two sessions = two processes on the same interpreter+packages, separate variables.

**Migration** backfills per project: one seeded `system` environment per language (resolves
to today's shared interpreter → zero behaviour change), and repoints existing
`execution_sessions` rows as sessions of that project/language.

---

## 3 — Environment resolution (the core seam)

Today `_make(language, project_uid)` (`kernel.py:563`) hard-codes the interpreter. Change:
resolve the project's environment for that language and launch its interpreter.

```
_make(language, project_uid)  ->
  system env (seeded default): today's behaviour — sys.executable / system Rscript
  managed python:  Kernel([<proj>/.cache/envs/python/bin/python, "-c", _PY_KERNEL_LOOP], cwd=…)
  managed r:       Kernel(["Rscript", "--vanilla", "-e", _R_KERNEL_LOOP], cwd=…,
                          env={ RENV_PROJECT: environments/r, R_LIBS: renv library })
```

- **`system` env**: resolves to today's shared interpreter — **nothing to build, runs
  immediately**. This is the PO's "let me run on an env whose packages are already
  installed" and the behaviour-preserving fallback before any managed env exists.
- **`managed` python**: interpreter = the project's uv venv python. If not materialised →
  **do not auto-build**; refuse with a clear "environment not built — build it first" (build
  is always explicit/manual, §4).
- **`managed` r**: shared `Rscript`, launched with renv activated (`RENV_PROJECT` / the env's
  `.Rprofile`) so `library()` resolves against the project's private renv library. Binary
  shared, library isolated — renv's own model.
- **`runtime.py`** (one-shot path) mirrors the same resolution.

---

## 4 — Provisioning & package management (new service + endpoints)

New service `app/services/execution/environments.py` + routes under `/environments`
(project-scoped, gated on the `ide` permission). No env-CRUD (the env exists per project per
language, seeded); endpoints act on **the** environment of a language.

| Method | Path | Purpose | Permission |
|---|---|---|---|
| GET | `/projects/{uid}/environments` | the project's 2 envs + status | `ide:read` |
| GET | `/projects/{uid}/environments/{lang}/packages` | list installed (from lockfile) | `ide:read` |
| POST | `/projects/{uid}/environments/{lang}/packages` | add package(s) → edit manifest + re-lock | `ide:write` |
| DELETE | `/projects/{uid}/environments/{lang}/packages/{pkg}` | remove → re-lock | `ide:write` |
| POST | `/projects/{uid}/environments/{lang}/build` | **manually** (re)materialise from lock | `ide:write` |
| GET | `/projects/{uid}/environments/{lang}/build-status` | poll build progress/logs | `ide:read` |

- **Install = declarative.** "Add package X" edits `pyproject.toml` / renv DESCRIPTION, runs
  `uv lock` / `renv::snapshot()`, then `uv sync` / `renv::restore()` into the project env
  cache — pulling from the **shared instance cache** (§1), so a version already present for
  another project isn't re-downloaded. The lockfile is the artefact; the venv is derived.
- **[REVISED 2026-07-31] Build runs AUTOMATICALLY on first run** (was "always manual").
  Reversed after the PO found the manual-only flow confusing: executing code against a
  managed env that isn't materialised triggers the build first (as a visible job), then
  runs — `environments.ensure_ready`. `POST …/build` still exists for an **explicit
  rebuild** (after a package change, or a failed build); the UI only shows the Build button
  when the env needs one. An empty env (no packages) resolves to the shared interpreter and
  never builds. The user-visible `system`/`managed` distinction is **dropped** — the UI just
  shows packages + a build/ready state.
- **Building is a JOB** (§6): `uv sync` / `renv::restore()` can take minutes → tracked
  background job, `/build-status` polls it.
- **[DECIDED] repos config**: Python index-url and R repos from server config (PyPI + p3m),
  overridable → future internal mirror.

---

## 5 — Git import / reproducibility flow

- **Export / commit**: `environments/{python,r}/` (manifest + lockfile) is part of the
  project tree → committed like `scripts/`. `.cache/` (both the per-project `envs/` and the
  shared store) is git-ignored.
- **Import (clone a project)**:
  1. Scan `environments/{python,r}/` → create the `environments` rows, status `draft`.
  2. **Do NOT auto-build** (§4). The user opens the project immediately; when they run code
     (or click Build) the managed env materialises from the committed lockfile, pulling
     shared-cache hits for free.
- **Entity-io / portal**: `buildProjectZip` must include `environments/` and exclude
  `.cache/`. Add the `environments/` block alongside the others in `buildProjectZip`
  (`entity-io.ts:479-697`) and to the layout comment (`entity-io.ts:249-271`); parse it in
  `parseNewLayout` / `importProjectContent`. Keep in sync with `linkr-portal`'s `build.sh`.
- **No per-artefact `environmentId`** to export (single env per language) — this is the big
  simplification vs the earlier plan: nothing to add on `Dashboard` / `DatasetFile` /
  `IdeFile`, no threading through the 6 execute call sites.

---

## 6 — Job management (long-running executions)

Environment **builds** are the first real long job; the same machinery serves long code runs.

### 6a. Job model
**[DECIDED] DB-backed jobs table** (survives a server restart): `{id, project_uid, user_id,
kind (build|run), status (queued|running|done|error|cancelled), progress, log_tail,
started_at, ended_at}`. Surfaces in the StatusBar / a jobs panel. On restart, jobs left
`running` (process gone) are reconciled to `error`/`interrupted` at startup.

### 6b. Concurrency — **[DECIDED 2026-07-30] bounded in-process executor**
uvicorn runs 1 worker. Long synchronous work must not block the event loop → builds/execs
run in a subprocess / thread pool behind an `asyncio.Semaphore` with a **concurrency cap**
(config, default ~2). No external broker (celery/RQ/arq) — it would break the
single-container / non-Docker deployment. The DB-backed *model* means we can swap in a real
queue later without a schema change; we escalate only if load demands it.
Interruption = SIGINT/kill of the job's process (the kernel `interrupt()` primitive at
`kernel.py:320` already exists; build-jobs get their own cancel).

### 6c. Streaming Run (folds in here)
- Editor "Run" → stream over the persistent kernel (the terminal path already streams; the
  button still batches). Same `TerminalSocket`-style plumbing.
- Real Stop / Ctrl+C wired to the job's interrupt — this is what makes a `Sys.sleep(100)` run
  visible **and cancellable** from the jobs panel (§7).
- **True real-time R streaming** (today buffered by `capture.output`, flushed at end) —
  requires an R-side incremental flush; its own sub-task.

### 6d. `max_sessions_per_user` — **[DECIDED 2026-07-30] rename → `max_kernels_per_user`**
Same behaviour (cap on live interpreter processes per user; `_count_for_user` already counts
kernels, `kernel.py:493`). "Session" is no longer the interpreter, so the name is
misleading. Read the old key as a fallback so existing configs keep working. The cap is on
**live processes**, never on environment or session *count* as a definition.

---

## 7 — UI

**The footer (`StatusBar.tsx`) is the entry point for environments** — not the
SessionDropdown.

- **[DECIDED] Environments require an open project.** The button
  (`StatusBar.tsx:97-105`) is disabled with a tooltip *"Open a project to manage its
  environments"* when `activeProjectUid` is null — aligns it with the project-scoped model
  and the already project-scoped kernel list.
- **Un-stub `EnvironmentsDialog.tsx` server branch** (`:432-438`): replace "coming soon"
  with the real manager for the active project — show the **Python** and **R** environment
  (kind system/managed, status), list/add/remove packages, and a **Build** button with
  progress. Reuse the front-only package-list UI shape; actions target `/environments`.
- **Env vs session in the footer**:
  - The footer already lists live **kernels** (`StatusBar.tsx:212-266`, keyed off
    `activeProjectUid`). A kernel line becomes: language · **session name** · Ready/Busy ·
    RSS · PID · restart. "0 kernels" until code runs is normal.
  - Replace `SessionDropdown` with a **session selector** (pick Session 1/2/…, or "new
    session") for the active project+language. The environment is implicit (one per
    language) so there is **no environment picker per script** — just the package manager
    dialog for the project's two envs.
- **Jobs indicator** in the footer: building / running / N queued, with a panel to view
  logs + **cancel** (§6). This is where a long `Sys.sleep(100)` run appears with a Stop
  button.
- **Import**: after cloning, a notification "environment(s) not built — Build?" per language
  (no auto-build).
- **Gating**: package ops on `ide:write`; execution on `ide:execute`; consistent with the
  permission catalogue — no new resource.
- **WASM (front-only)**: unchanged — browser packages stay managed by the front-only
  `EnvironmentsDialog` branch. Sessions/jobs/managed-env are **server-mode** features, inert
  in front-only.

---

## 8 — Sequencing (keep the app usable at each step)

1. **Model + resolution** — `environments` table (unique `(project_uid, language)`), seed a
   `system` env per language resolving to today's interpreter (zero behaviour change);
   repurpose `execution_sessions` as sessions; add `session_id` to the kernel key; thread it
   through `_make`. **Behaviour-preserving.**
2. **Sessions + cap rename** — ✅ *done.* Multi-session already worked end-to-end
   (`SessionDropdown`, `execution_sessions`, `/execute/sessions*`); this step renamed the
   cap `max_sessions_per_user` → `max_kernels_per_user` (config alias keeps the old env var
   working) since a "session" is no longer the interpreter. The footer selector stays as-is
   until step 3 makes env≠session user-visible (then it gains the env name per kernel line).
3. **Python env (uv)** — ✅ *done.* Shared uv cache under `data_dir/.cache/uv`, project venv
   under `.cache/envs/python/`, `uv_provisioner` (manifest + `uv add/remove --no-sync` +
   `uv sync` off the event loop), `/projects/{uid}/environments…/{packages,build}` routes
   gated on `ide:read|write`, and a `ServerEnvironmentsPanel` replacing the dialog stub.
   Build stays **manual**. Build-as-tracked-job is step 4 (today `/build` runs in a thread
   and returns ready/error synchronously).
4. **Job management** — ✅ *done.* `jobs` table (DB-backed), a bounded in-process executor
   (`asyncio.Semaphore(max_build_concurrency)`, no broker), `/projects/{uid}/jobs` +
   `/jobs/{id}/cancel` routes, startup reconciliation of orphaned `running` jobs, and a
   footer `JobsIndicator` (poll + cancel). Env build now runs as a cancellable job (uv sync
   as an async subprocess, killed on cancel). Reused by Run in step 7.
5. **R env (renv)** — ✅ *done.* `renv_provisioner` mirroring the uv one (record →
   `renv::restore(library=…)` as an async subprocess), shared renv cache under
   `data_dir/.cache/renv`, p3m repos default, `_make` puts the managed R env's private
   library on `R_LIBS`. Env/jobs routes moved to their own `routes/environments.py` (they
   live at `/projects/{uid}/…` + `/jobs/…`, not under `/execute`); the panel is now
   language-parametric with Python + R tabs.
6. **Git import/export** — ✅ *done.* The server export (`build_project_tree` +
   `_read_env_specs` in the assemble layer) writes `environments/<lang>/` spec files into
   the tree; `.cache/` was already gitignored on both front and server (byte-parity holds —
   front-only emits no specs, server emits none without a managed env). Import needs **no**
   JSZip wiring: `environments.resolve` detects a committed lockfile on disk and seeds the
   row `managed`/`draft` ("needs build") on first access — **no auto-build**. Portal
   `build.sh` needs no change (it clones committed files; `.cache/` is never committed).
7. **Finishing touches** — ⏳ *deferred (best built + verified against a live kernel, not
   blind).* Two UX-polish items:
   - **Streaming Run button**: the IDE Run still batches via HTTP `executeOnServer`
     (`FilesPage.tsx:576`); routing it through the terminal streaming WS + a real Stop is a
     substantial change to how an `ExecutionResult` is modelled (single object → stream).
   - **True real-time R streaming**: needs an R-side incremental flush in `_R_KERNEL_LOOP`
     (today buffered by `capture.output`, emitted at end).
   - **Code runs as jobs**: a long script run (e.g. `Sys.sleep(5)`) does NOT appear in the
     jobs panel today — only **builds** create a `Job` (`kind="build"`). Surfacing runs as
     `kind="run"` jobs (visible + cancellable) folds in with the streaming Run work here.
   Neither blocks the feature — batch Run works; builds/long jobs already stream status via
   the jobs panel (step 4). The `render` purpose guard in `_require_execute` is load-bearing
   security (refuses a viewer-gate downgrade), **not** a cosmetic enum — it stays; the
   earlier "drop render from the enum" note is withdrawn.

Steps 1–6 ship the feature end to end (behaviour-preserving step 1; managed uv/renv envs;
jobs; git round-trip). Step 7 is optional polish layered on top.

---

## 9 — Open points

Settled:
- **[DECIDED 2026-07-30]** One environment per language per project (no catalogue, no
  per-artefact selection, no derivation).
- **[DECIDED 2026-07-30]** Session ≠ env; multiple sessions per env, local, never exported.
- **[DECIDED 2026-07-30]** Package cache shared instance-wide (uv + renv).
- **[REVISED 2026-07-31]** Build runs auto on first run (was "always manual"); explicit
  rebuild still available. No user-visible system/managed tier. Workspace-level default
  package preset (Workspace Settings → Default environments) + per-package update/update-all.
- **[DECIDED 2026-07-30]** Job executor = bounded in-process (no external broker); DB-backed
  model keeps a future queue swap cheap.
- **[DECIDED 2026-07-30]** `max_sessions_per_user` → `max_kernels_per_user` (cap on live
  processes).
- **[DECIDED]** Jobs → DB-backed / persisted.

Still open:
- **[OPEN]** Disk GC for `.cache/envs/` — deferred. The shared store dedups package bytes;
  `DELETE`/rebuild cleans a project's links. No auto-GC or quota in v1; revisit on real
  usage signals.
