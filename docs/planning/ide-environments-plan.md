# Linkr IDE — Environments & Job management (design plan)

> Design document, **not yet implemented**. Scope: turn the IDE's `env_id` from a
> pure namespace label into a **real, reproducible environment** (isolated packages),
> and add **job management** for long-running executions. Server / full-stack mode only —
> front-only (WASM) keeps its browser-side package install unchanged.
>
> Decisions ratified with the PO (2026-07-12) are recorded inline as **[DECIDED]**.
> Open points are marked **[OPEN]**.

---

## 0 — Where we are today (current state, verified)

- **`env_id` is only a namespace label.** Kernels are keyed
  `(project_uid, user_id, language, env_id)` (`kernel.py:457`), but `_make()`
  (`kernel.py:547`) ignores `env_id` entirely: every Python kernel runs the backend's
  own `sys.executable`, every R kernel runs the system `Rscript`. Two env ids = two
  processes, **same interpreter, same packages**, differing only by in-memory globals.
- **`ExecutionSession`** (`models/execution_session.py`) = `{id, project_uid, user_id,
  name}`. Its own docstring: *"a session is a namespace, not a virtualenv."*
- **No environment table, no package-management endpoint, no runtime install path.**
  `EnvironmentsDialog.tsx:432` is a "coming soon" stub in server mode; the real
  install/uninstall logic only targets the browser WASM engines (front-only).
- **Docker image** `rocker/r-ver` + Posit Package Manager (p3m) binary repo: one shared
  Python venv at `/opt/venv`, one system R library, all packages baked at build time.
- **Sessions**: `session_timeout_minutes` (idle eviction) + `max_sessions_per_user`
  enforced in `KernelManager`; StatusBar footer shows Ready/Busy/RSS/PID/restart.

The whole point of this plan: make the 4th key element (`env_id`) resolve to a **real
interpreter + real isolated package set**, defined **declaratively** so it can be
derived and reproduced.

---

## 1 — Ratified decisions (the frame)

- **[DECIDED] Scope = per PROJECT, shared.** An environment belongs to the project, not
  the user. A project can define several environments (e.g. `default`, `deep-learning`,
  `geo`); each user *picks* one. Runtime isolation between users is already handled by
  the kernel key (`user_id` is in the tuple): same env *definition*, separate *process*
  per user — no shared variables. Rationale: only a project-scoped env can travel inside
  the project's git → it is the precondition for open-science reproducibility.
  "Several environments per user" is satisfied by "a user chooses among the project's
  environments", **not** by per-user private envs. A purely personal throwaway env is
  covered by **derivation** (below); a dedicated per-user tier can be layered later
  without breaking this model.
- **[DECIDED] Declarative definition.** An environment = a **manifest + lockfile**, both
  versioned in the project git. This single choice unifies the three needs:
  - *isolation* → each env has its own package set;
  - *derivation* → copy a manifest, add/remove packages, re-lock (base + delta);
  - *reproducibility* → the manifest+lock is committed, so `clone → build` reconstructs it.
  We never model an environment as "a process where installs were typed by hand".
- **[DECIDED] Python via `uv`, R via `renv`, model language-agnostic from day one.**
  `uv` is the current ecosystem standard (cross-platform `uv.lock`, manages its own
  interpreters, PyPI-native, ~100× faster than pip/conda, shared global cache). `renv` is
  the R standard (private per-project library, `renv.lock`, global cache). The data model
  stores `language + manifest + lockfile` agnostically; the resolver picks the toolchain.
- **[DECIDED] Internet assumed available** (no air-gapped support in v1). Install runs
  directly against PyPI / p3m. BUT the index URL / repos stay **configurable** so a future
  internal mirror (SPE) is a config change, not a re-architecture.
- **[DECIDED] R repos default to p3m** (`packagemanager.posit.co`), not bare CRAN. p3m is
  a public web service, **independent of Docker** — it neutralises the "compile from
  source" slowness on Linux servers whether or not we run in a container.
- **[DECIDED] System dependencies are the machine/image's responsibility, not Linkr's.**
  This is the exact same boundary an RStudio container draws: R *packages* → renv
  (resolvable at runtime); *system libs* (GDAL, libxml2, libcurl…) → baked in the image
  (Docker) or installed by the host admin (non-Docker). Linkr **diagnoses** a missing
  system dep (actionable message, optionally via Posit `r-system-requirements`) but never
  `apt install`s it. Hors-Docker has the same angle as native RStudio Server — nobody
  solves system deps at runtime, and we don't pretend to.

### Docker vs non-Docker (explicit, because deployments are often non-Docker)

| | **Docker** (recommended) | **Non-Docker** (server / personal PC) |
|---|---|---|
| System deps | Baked in `rocker/r-ver` image — guaranteed | Host admin's responsibility (like native RStudio Server) |
| R binaries | p3m repo (fast) | p3m on Linux server; CRAN native binaries on macOS/Windows |
| Python | `uv` provisions venvs under `data_dir` | same — `uv` is self-contained |
| renv cache | inside container (ephemeral unless volume) | per-machine `~/.cache/R/renv` (persists, shared across projects) |
| Interpreter discovery | fixed paths | **config + autodetect** (where are Rscript / uv / caches) |

The model is identical in both; only *interpreter/cache discovery* and *who provides
system libs* differ. Both captured as server config with autodetection.

---

## 2 — Data model

### 2a. `environments` table (new)

Project-scoped, language-agnostic. One row per environment definition.

| Column | Type | Note |
|---|---|---|
| `id` | uuid PK | replaces the free-form `env_id` string; `"default"` becomes a real seeded row |
| `project_uid` | FK projects, CASCADE | scope |
| `language` | enum `python` \| `r` | which toolchain resolves it |
| `name` | str | display name (`default`, `deep-learning`…) |
| `description` | str? | optional |
| `derived_from_id` | FK environments? | lineage for **derivation** (nullable) |
| `manifest_path` | str | relative path in project git (`environments/<name>/…`) |
| `status` | enum `draft`\|`building`\|`ready`\|`error` | reflects last provision |
| `interpreter_path` | str? | resolved venv python / renv library root (server-computed, not in git) |
| timestamps, author | | |

- **The manifest + lockfile live on disk in the project git** (source of truth for
  reproducibility), NOT as blobs in the DB. The row is the DB-side index/metadata.
  This mirrors the §08 rule of `fullstack-storage-plan.md`: *disk is the single source
  for `scripts/` and `datasets/`* — environments join that list.
- `interpreter_path` and `status` are **recomputable** (server-local, machine-specific) —
  never committed to git (a venv path on machine A is meaningless on machine B).

### 2b. On-disk layout (extends §05 of the storage plan)

```
projects/<uid>/
├─ scripts/
├─ datasets/
├─ environments/                     # [NEW] versioned in the project git
│  ├─ default/
│  │  ├─ pyproject.toml + uv.lock     # Python env (uv)
│  │  └─ (or) renv.lock + .Rprofile   # R env (renv)
│  └─ deep-learning/ …
└─ .cache/
   ├─ datasets/
   └─ envs/<env-id>/                  # [NEW] resolved venv / renv library — NEVER in git
```

- `environments/<name>/` = the **declarative spec** (committed).
- `.cache/envs/<env-id>/` = the **materialised** venv (Python) or renv project library —
  machine-local, rebuildable from the spec, git-ignored. Uses the global uv / renv cache
  so multiple envs share package storage on disk.

### 2c. `ExecutionSession` — kept, redefined

Today a session *is* the env id. We split the two concepts cleanly:
- **Environment** = *what* runs (interpreter + packages), project-scoped, shared, versioned.
- **Session** = *a live namespace* over an environment (in-memory variables), per user.

**[DECIDED] Session and environment are collapsed — the environment is the unit.**
There is no separate "session" layer in v1. The kernel key stays
`(project_uid, user_id, language, environment_id)`: one live process per user per env per
language. The `SessionDropdown` becomes an **environment selector**; "restart" (already in
the footer) covers the "fresh namespace" need that named sessions used to serve.
`ExecutionSession` (table `execution_sessions`) is **retired**: its rows migrate to
`environments` (the old `id`/`env_id` becomes the env id, `"default"` becomes a seeded
default env), and its route family (`/execute/sessions*`) is removed in favour of
`/environments`. Migration must backfill a `default` environment per project so existing
kernels keep resolving.

---

## 3 — Environment resolution (the core seam)

Today `_make(language, project_uid)` at `kernel.py:547` hard-codes the interpreter.
The change: pass the resolved environment and launch its interpreter.

```
_make(language, project_uid, environment)  ->
  python: Kernel([<env>/.cache/envs/<id>/bin/python, "-c", _PY_KERNEL_LOOP], cwd=…)
  r:      Kernel(["Rscript", "--vanilla", "-e", _R_KERNEL_LOOP], cwd=…,
                 env={ RENV_PROJECT: environments/<name>, R_LIBS: renv library })
```

- **Python**: the interpreter is the env's uv venv python (`.cache/envs/<id>/bin/python`).
  If the venv isn't materialised yet → provision on first use (or refuse with a clear
  "environment not built" if we want build to be explicit).
- **R**: same system `Rscript`, but launched with `renv` activated for the env
  (`RENV_PROJECT` / the env's `.Rprofile`), so `library()` resolves against the env's
  private renv library. Interpreter binary is shared; the *library* is isolated —
  which is exactly renv's model.
- **`runtime.py`** (one-shot path) mirrors the same resolution for consistency, even
  though `/execute` uses the kernel path today.

Fallback: the seeded `default` env resolves to today's behaviour (shared venv / system
library) so nothing breaks before any custom env exists.

---

## 3bis — Which environment a surface runs in (per-consumer selection)

**[DECIDED] The environment is defined at project level, but *selected per code-running
surface*.** The project owns the *list* of environments (versioned in its git); each
surface that runs code *references* one by `environment_id`, defaulting to the project's
`default` when unset. Rationale: a dashboard pinned to `plotly 5.x` must not break because
an analyst bumped `plotly` in another env — reproducibility is per-artefact, and the
pinned env travels with the artefact on export/clone. Same pattern as an RStudio project
with a renv where a document declares its own profile: "what's available" is project-level,
"which one I use here" is per-consumer.

**Today (verified): env selection is a single global per-project choice.** Every
`executeOnServer` call site (IDE, dashboard inline/plugin/preview, dataset analysis,
patient-data) omits `envId` and falls back to `getActiveSessionId(projectUid)`
(`lib/api/execution.ts:36-38`); the only selector UI is the IDE's `SessionDropdown`
(`FilesPage.tsx`). No type carries an env field.

**The plumbing already supports per-surface override with no store change**: `opts.envId`
takes precedence over the global fallback (`execution.ts:37`). So each surface just needs
to (1) store its chosen `environment_id`, (2) pass it into the `executeOnServer` opts,
(3) offer a selector.

Surfaces and where the selector goes:

| Surface | Store the env on | Selector UI | Execute call site to thread |
|---|---|---|---|
| **IDE** | the footer's active env (per project, was the session) | footer env selector (§7) | `FilesPage.tsx:556`, `RmdNotebook.tsx:493` |
| **Dashboard** | `Dashboard.environmentId` (new field on the `Dashboard` type) | **field in `DashboardSettingsDialog`** | `InlineCodeWidgetRenderer.tsx:42`, `PluginWidgetRenderer.tsx:78`, `WidgetEditorDialog.tsx:216` |
| **Dataset analyses** | `environment_id` on the dataset-analysis scope (per dataset) | **settings icon next to the "+" add-analysis button** (`AnalysesPanel.tsx:172`) — new control | `AnalysisShell.tsx:119` |
| **Patient-data widgets** | project default for now (revisit if needed) | none v1 → uses project default | `warehouse-plugin-executor.ts:68/91` |

- **Granularity chosen**: env is set **per dashboard** and **per dataset** (the analyses of
  a dataset share one env). Not per-widget / per-analysis in v1 — coarser is simpler and
  matches "this dashboard's environment" / "this dataset's analysis environment". A finer
  grain can be layered later (a widget/analysis overriding its parent) without rework,
  since the override already flows through `opts.envId`.
- **Data model additions**: nullable `environment_id` FK (`ON DELETE SET NULL` → falls
  back to project default) on `dashboards` and on the dataset-analysis owner (the dataset
  row, or `dataset_analyses` — TBD by where analyses are keyed). Nullable = "use project
  default", so nothing is forced and existing rows keep working.
- **Reproducibility**: these `environment_id`s are part of the exported entity (dashboard
  export, project export) so a cloned dashboard/dataset requests the same env — which the
  import build flow (§5) will have materialised.
- **WASM (front-only) mode**: `analysis-executor.ts` has no env concept and never will
  (browser packages are managed by the front-only `EnvironmentsDialog`). Per-surface env is
  a **server-mode** feature; the selector is hidden / inert in front-only, like the rest.

---

## 4 — Provisioning & package management (new service + endpoints)

New service `app/services/execution/environments.py` + routes under `/environments`
(workspace/project-scoped, gated on the `ide` permission — see §7).

| Method | Path | Purpose | Permission |
|---|---|---|---|
| GET | `/projects/{uid}/environments` | list project envs | `ide:read` |
| POST | `/projects/{uid}/environments` | create env (optionally `derived_from`) | `ide:write` |
| DELETE | `/environments/{id}` | delete env (spec + cache) | `ide:delete` |
| POST | `/environments/{id}/packages` | add package(s) → update manifest + re-lock | `ide:write` |
| DELETE | `/environments/{id}/packages/{pkg}` | remove package → re-lock | `ide:write` |
| GET | `/environments/{id}/packages` | list installed (from lockfile) | `ide:read` |
| POST | `/environments/{id}/build` | (re)materialise venv/renv library from lock | `ide:write` |
| GET | `/environments/{id}/build-status` | poll build progress/logs | `ide:read` |

- **Install = declarative, not imperative.** "Add package X" edits the manifest
  (`pyproject.toml` / `renv` DESCRIPTION), runs `uv lock` / `renv::snapshot()`, then
  `uv sync` / `renv::restore()` into the env cache. The lockfile is the artefact; the
  materialised venv is derived from it. This is what makes derive + reproduce free.
- **Derivation** = create env with `derived_from_id` → copy the base manifest+lock into
  the new env's folder, then the user applies a delta (add/remove) and re-locks. Lineage
  kept in `derived_from_id` for display.
- **Building is a JOB** (§6): `uv sync` / `renv::restore()` can take minutes → runs as a
  tracked background job, not a blocking request. `/build-status` polls it.
- **[DECIDED] repos config**: Python index-url and R repos come from server config
  (default PyPI + p3m), overridable → future internal mirror.

---

## 5 — Git import / reproducibility flow

Ties into the in-progress **project versioning** work (git-sync-store).

- **Export / commit**: `environments/<name>/` (manifest + lockfile) is part of the
  project tree → committed and pushed like `scripts/`. `.cache/envs/` is git-ignored.
- **Import (clone a project from another git)**:
  1. Scan `environments/*/` → create `environments` rows (status `draft`).
  2. Offer to **build** them (materialise venv/renv library from the committed lockfiles)
     — one build job per env. The user opens the project immediately; envs build in the
     background and flip to `ready`.
  3. On success the code runs "in the same conditions" — the open-science goal.
- **Entity-io / portal**: `buildProjectZip` must include `environments/` and exclude
  `.cache/envs/`. Keep in sync with `linkr-portal`'s `build.sh` (see CLAUDE.md related-repos).

---

## 6 — Job management (long-running executions)

Backlog item *"IDE — job management: tracking/interruption of long processes (± job
queue)"* + *"editor Run in streaming (+ Stop/Ctrl+C)"*. Environment **builds** are the
first real long job, so this lands naturally alongside §4.

### 6a. Job model
**[DECIDED] DB-backed jobs table** (persisted, survives a server restart — chosen over an
in-memory-only registry for the multi-user warehouse case): `{id, project_uid, user_id,
kind (build|run|…), status (queued|running|done|error|cancelled), progress, log_tail,
started_at, ended_at}`. Jobs surface in the StatusBar / a jobs panel. On server restart,
jobs left `running` (whose process is gone) are reconciled to `error`/`interrupted` at
startup — the row survives, the process does not.

### 6b. Concurrency
- **[OPEN] uvicorn runs on 1 worker today** (noted in the storage plan backlog). Long
  synchronous work must not block the event loop → builds/execs run in a subprocess /
  thread pool with a **concurrency cap** (config). A real job *queue* (celery/RQ/arq) is
  heavier; for v1 an in-process bounded executor + queue is likely enough. Decide with load
  expectations (SPE multi-user vs personal PC).
- Interruption = SIGINT/kill of the job's process (the kernel `interrupt()` primitive at
  `kernel.py:320` already exists for run-jobs; build-jobs get their own cancel).

### 6c. Streaming Run (finishing touch, folds in here)
- Editor "Run" button → stream over the persistent kernel (the terminal path already
  streams; the button still batches). Same `TerminalSocket`-style plumbing.
- Real Stop / Ctrl+C wired to the job's interrupt.
- **True real-time R streaming** (today buffered by `capture.output`, flushed at end) —
  requires an R-side incremental output flush; tracked as its own sub-task.

---

## 7 — UI

**The footer (`StatusBar.tsx`) is the entry point for environments** — not the
SessionDropdown. Today `StatusBar.tsx:97-105` renders a "Environments (package manager)"
button opening `EnvironmentsDialog`, and the footer already lists the project's live
**kernels** (`StatusBar.tsx:217-247`, keyed off `activeProjectUid`, `:67-68`).

- **[DECIDED] Environments are per-project → the footer button must require an open
  project.** Today the button is marked *"global, accessible from every page"*
  (`StatusBar.tsx:97`) and opens with no active project — that is now **incoherent** with
  the project-scoped model (an env belongs to a project; there is nothing to manage
  outside one). Fix: when `activeProjectUid` is null, **disable** the Environments button
  with a tooltip *"Open a project to manage its environments"* (i18n key). This aligns it
  with the kernels list, which is already project-scoped.
- **Un-stub `EnvironmentsDialog.tsx` server branch** (`:432`): replace "coming soon" with
  the real env manager for the **active project** — list project envs, create,
  **derive from**, add/remove packages (with build feedback), delete. Reuse the existing
  front-only package-list UI shape; the actions target the new `/environments` API instead
  of the WASM engines.
- **Kernels in the footer** = live server interpreter processes (Python/R) holding
  in-memory variables, created lazily on first execution, shown with Ready/Busy + RSS +
  PID + restart (`StatusBar.tsx:221-246`). "0 kernels" is normal until code is run in an
  open project. Once env is real, each kernel line shows **which environment** it belongs
  to (today it only shows `· {envId}` when non-default, `:224` — becomes the env name).
- **Env selector**: replace the Session dropdown (`SessionDropdown.tsx`) with an
  **environment selector** for the active project (per §2c we lean toward collapsing
  session into env). The choice flows as `environment_id` into `/execute` and the terminal
  WS, replacing today's `envId`=session UUID.
- **StatusBar footer**: also surface a **jobs** indicator (building / running / N queued)
  with a panel to view logs + cancel (§6).
- **Per-surface env selectors (§3bis)**:
  - **Dashboard** — add an "Environment" field to `DashboardSettingsDialog.tsx` (writes
    `Dashboard.environmentId`).
  - **Dataset analyses** — add a **settings icon next to the "+" add-analysis button**
    (`AnalysesPanel.tsx:172`) opening a small env picker for the dataset's analyses.
  - Both list the active project's environments; both default to "Project default".
- **Import**: after cloning a git project, a prompt/notification "N environments to build"
  with per-env build progress.
- **Gating**: env CRUD + package ops on `ide:write`/`ide:delete`, execution on
  `ide:execute` — consistent with the validated permission catalog
  (`users-authorizations-audit.md`). No new permission resource needed.

---

## 8 — Sequencing (keep the app usable at each step)

1. **Model + resolution** — `environments` table, seed a `default` row per project
   resolving to today's shared interpreter (zero behaviour change), thread
   `environment_id` through the kernel key + `_make`.
2. **Python envs (uv)** — provision venv under `.cache/envs/`, `/environments` +
   `/packages` endpoints, build-as-job, un-stub the dialog for Python.
3. **Job management** — jobs table + bounded executor + StatusBar jobs panel + cancel
   (needed by build; reused by Run).
4. **R envs (renv)** — same endpoints, renv library provisioning, p3m repos default.
5. **Per-surface env selection (§3bis)** — nullable `environment_id` on dashboards +
   dataset analyses, thread it into the `executeOnServer` opts at each call site, add the
   dashboard-settings field and the dataset "+"-adjacent env picker. (Depends on step 2:
   real envs must exist to be selectable.)
6. **Git import build flow** — scan `environments/`, build jobs on import; entity-io +
   portal sync (include per-surface `environment_id`s in the export).
7. **Finishing touches** — streaming Run button (+ Stop/Ctrl+C), true real-time R streaming.

Each step ships independently; step 1 is behaviour-preserving.

---

## 9 — Open points to settle

Settled:
- **[DECIDED]** Session vs env → **collapsed**, env is the unit (see §2c).
- **[DECIDED]** Jobs → **DB-backed / persisted** (see §6a).

Still open:
- **[OPEN]** Job executor: bounded in-process executor vs a real queue (celery/RQ/arq)?
  The DB-backed *model* is decided; the *runner* is not. Leaning bounded in-process
  executor for v1 (uvicorn is 1 worker), escalate to a real queue only if load needs it.
- **[OPEN]** Build on import: auto-build all envs, or build-on-first-use per env?
- **[OPEN]** `max_sessions_per_user` semantics once env exists — cap on live processes,
  or on env count, or both? (The setting name may be renamed to `max_kernels_per_user`
  now that "session" is retired.)
- **[OPEN]** Disk quota / GC for `.cache/envs/` (materialised venvs can be large; global
  cache dedups but per-env metadata still accumulates).
