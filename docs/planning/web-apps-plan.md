# Web apps in the IDE — plan

Let a project's code start a **long-running web server** — Shiny, Streamlit, Dash, Gradio,
plumber, FastAPI/Flask, Panel, Marimo — and show it inside Linkr, in an iframe, without the
user ever seeing a port number. Server mode only (a WASM build has no process to spawn).

Nothing of this exists today. The closest prior art in the repo is `pty_kernel.py`: the only
place that already spawns a detached, long-lived child process with the project's cwd and
env. Everything else in `services/execution/` is request/response.

## The framework-agnostic principle

**Linkr must not know what Shiny is.** A framework is only ever a *preset*: a label, a way to
detect a candidate file, and an argv template with a port placeholder. The runtime — spawn,
port, readiness probe, proxy, idle GC, teardown — treats every app as "a process that will
eventually listen on `127.0.0.1:$PORT`".

Three consequences worth stating up front, because they constrain the whole design:

1. **No framework-specific code paths in the proxy.** It forwards bytes and upgrades
   WebSockets. If a framework needs something special, the fix belongs in its preset's argv,
   or in the app's own code — never in a `if framework == "shiny"` branch.
2. **Presets are data, not code.** A table in one module, extensible by the user through a
   free-form "custom command" that skips detection entirely. A framework we never heard of
   must be launchable on day one.
3. **The escape hatch is the contract.** `Custom command` + `$PORT` is the primitive; the
   presets are convenience on top. If the primitive can't run something, the design is wrong.

## Decisions to arbitrate (proposed, not settled)

| Question | Proposal |
|----------|----------|
| Path prefix | **`/api/v1/apps/{app_id}/…`** — inherits nginx's existing WS upgrade + 3600s timeouts for free |
| Origin | **Same origin as Linkr.** A wildcard-subdomain deployment is the only true isolation and it is not deployable on a GitLab-Pages-style setup |
| iframe sandbox | **No `sandbox` attribute** on app frames — breaks the established `allow-scripts`-only rule, see § Security |
| Auth for in-iframe requests | **Opaque per-app path token** in the URL, not a cookie — no `SameSite`/`HttpOnly` matrix to get wrong, and it dies with the app |
| Blocking | **Never.** An app is its own detached process, not a kernel run — the R/Python session stays free (see § Never blocking) |
| Process registry | **In-memory `AppManager`** owns the lifecycle; a `kind="app"` job row shadows it for the Jobs panel (see § Job registry) |
| Port allocation | Bind-probe a configurable range on `127.0.0.1`, retry on collision |
| Quota | Separate `max_apps_per_user` (default 2), **not** shared with `max_kernels_per_user` |
| Idle eviction | Last **proxy request** timestamp, not kernel-style `idle_seconds()` (see § Idle) |
| Frontend surface | A **full tab**, like `TerminalTab` — not an `OutputPanel` bottom-panel tab |
| Permission | Reuse **`ide:execute`**. Starting an app is not more privileged than `system()` from a kernel |

## Never blocking — the core requirement

An app **must not occupy the R or Python session it was started from**. Running
`shiny::runApp()` in the IDE today blocks the kernel until `execution_timeout_seconds`, and
the whole IDE with it — that is precisely the problem this feature exists to solve.

The design gives this for free, and it is worth being explicit about why: an app is **never
executed by a kernel**. `AppManager` spawns its own `create_subprocess_exec` child, detached
via `start_new_session=True`, with no stdin protocol and no relationship to any kernel. The
HTTP start request returns as soon as the readiness probe resolves (or immediately, with
`status: "starting"`) — it never waits for the app to exit. The user's R session stays warm,
their variables intact, and they can keep running cells against the same data the app reads.

Corollaries the implementation must respect:

- **No kernel, no `run_ephemeral`, no warm pool.** Reusing any of those would re-couple the
  app's lifetime to a kernel's.
- **No `asyncio.wait_for` around the process.** The only time bound on an app is idle
  eviction (§ Idle), never a run timeout.
- **stdout/stderr go to a bounded deque**, pumped by a background task — not returned to a
  caller who is waiting.
- Starting an app must not consume a kernel slot: hence a **separate** `max_apps_per_user`.

## Job registry: visibility without ownership

`kind="app"` in the `jobs` table looks like the natural home — `models/job.py:26` already
invites it, and `jobs.reconcile_on_startup()` would correctly mark orphaned apps as `error`
after a restart. But the **lifecycle** cannot live there:

- `jobs.py:67` runs every body behind a semaphore bounded by `max_build_concurrency`
  (**2**). An app would hold a slot for its entire life, starving env builds and other apps.
- `jobs._run()` treats body-returns as `done`; a job body is expected to finish. An app's
  body doesn't.
- `run_jobs.start()` wraps its run in `asyncio.wait_for(..., job_timeout_seconds)` (1800s).
  An app must outlive that.

So the split is: **`AppManager` owns the process; the `jobs` table owns the *visibility*.**
On start, insert a `kind="app"` row with `status="running"` and the app's label — never
`jobs.launch()`, so the semaphore is untouched — and update it to `done` / `error` on stop or
crash, streaming the log tail into `log_tail` as the pump reads it. Three things fall out:

- The app appears in the existing **JobsIndicator** status-bar panel alongside builds and
  runs, so a user who closed the app tab still sees it running and can stop it.
- `jobs.cancel()` needs to reach it: register a cancel hook that calls `AppManager.stop()`
  rather than cancelling an asyncio task (`jobs.cancel()` at `jobs.py:111-117` looks up
  `_tasks` and returns `False` when absent — a small extension, not a rewrite).
- `reconcile_on_startup()` marks a restart-orphaned app `error` for free, which is honest:
  its process really is gone.

The in-memory registry remains the source of truth for what is *actually running*. The DB row
is a shadow for the UI. If they ever disagree, the registry wins.

## Data model

No table. One in-memory record per running app:

```python
@dataclass
class WebApp:
    app_id: str            # opaque, unguessable — this is also the auth token (see Security)
    project_uid: str
    user_id: int
    label: str             # "app.R", "dashboard.py" — what the tab shows
    framework: str         # preset key, or "custom"; display + argv only, never behaviour
    port: int
    proc: asyncio.subprocess.Process
    started_at: float
    last_seen: float       # monotonic, bumped by the proxy on every forwarded request
    status: Literal["starting", "ready", "failed", "stopped"]
    log: deque[str]        # bounded tail, ~200 lines, from the child's stdout+stderr
```

Keyed `(project_uid, app_id)` in `AppManager._apps`, with a parallel `_owner` dict for the
per-user quota — the `PtyManager:147-148` shape.

## Presets

One module-level table. Each entry: how to recognise a candidate, and how to launch it.

```python
PRESETS = [
    Preset(key="shiny",     language="r",      match=("app.R", "ui.R", "server.R"),
           argv=["{rscript}", "-e", "shiny::runApp('{dir}', port={port}, host='127.0.0.1')"]),
    Preset(key="plumber",   language="r",      match=("plumber.R",),
           argv=["{rscript}", "-e", "plumber::pr_run(plumber::pr('{file}'), port={port}, host='127.0.0.1')"]),
    Preset(key="streamlit", language="python", match_content=r"^\s*import streamlit",
           argv=["{python}", "-m", "streamlit", "run", "{file}",
                 "--server.port", "{port}", "--server.address", "127.0.0.1",
                 "--server.headless", "true"]),
    Preset(key="dash",      language="python", match_content=r"\bdash\.Dash\("),
    Preset(key="gradio",    language="python", match_content=r"\bimport gradio"),
    Preset(key="panel",     language="python", match_content=r"\bimport panel"),
    Preset(key="marimo",    language="python", match_content=r"\bimport marimo"),
    Preset(key="asgi",      language="python", match_content=r"\b(FastAPI|Flask)\("),
]
```

`{python}` / `{rscript}` come from the **project environment**, not from the server —
see § Interpreter resolution. `{port}` is allocated by the manager. A `custom` framework
takes a raw command string from the user with `$PORT` interpolated; detection is skipped.

Some frameworks need the app told where it is mounted. Dash has `requests_pathname_prefix`,
Streamlit has `--server.baseUrlPath`, Shiny is prefix-agnostic. **We do not fix this per
framework**: instead the proxy rewrites the mount point (§ Path rewriting), and
`LINKR_APP_BASE_PATH` is exported into the child's env so an app that wants to cooperate can.
Presets that accept a base-path flag get it wired in their argv; the rest rely on rewriting.

## Interpreter resolution — the one refactor needed

`kernel._make()` (`kernel.py:1135-1217`) is where "which Python / which Rscript, with which
env vars, in which cwd" is decided today: `project_fs.ide_dir()` for cwd,
`project_fs.runtime_env()` for `LINKR_*`, then the Python branch (venv interpreter +
`PYTHONPATH` prefixed with the client package) and the R branch (`LINKR_R_LIB`,
`LINKR_R_SANDBOX`, `LINKR_R_KERNEL_LIB`, `LINKR_CLIENT_R_LIB`).

An app must launch with **exactly** that resolution — an app importing `linkr` or a package
from the project's renv library has to see the same world its kernel does. So extract from
`_make` a pure helper:

```python
def runtime_spec(language, project_uid, environment, token) -> RuntimeSpec:
    """cwd, env dict, and the interpreter path — everything but the argv."""
```

`_make` then builds its `Kernel` from it, and `AppManager` builds its argv from it. This is
the only invasive change to existing code; it must not alter kernel behaviour (the R
`.libPaths()` pinning is subtle and load-bearing).

Before launching, call `environments.ensure_ready(...)` (`environments.py:309-366`) exactly
as `run_jobs.start()` does — an app whose env was never built should trigger the build and
stream it, not fail.

## Lifecycle

**Start** — `POST /api/v1/apps`: `{projectUid, path, framework?, command?}`. Returns in
milliseconds; nothing here waits for the app to finish.
1. `_require_code_execution(db, project_uid, user)` — same gate as the terminal WS.
2. Quota check → 429 (`KernelLimitReached` precedent, `execution.py:280-281`).
3. `ensure_ready` for the language's environment. **This is the one blocking step** — a first
   run may build the venv/renv library. It streams into the job log like any build, and only
   happens once per environment.
4. Allocate a port; build argv from the preset + `runtime_spec`.
5. `create_subprocess_exec(..., start_new_session=True, stdout=PIPE, stderr=STDOUT)` —
   `start_new_session` is what later makes killing the whole tree possible.
6. Insert the `kind="app"` job row (§ Job registry) and pump stdout into both the bounded
   `log` deque and `log_tail`, in a background task (`_spawn_bg` pattern, `kernel.py:1404`).
7. **Readiness probe** as a background task, not inline: poll `127.0.0.1:{port}` until it
   accepts a TCP connection, or the process exits, or `app_start_timeout_seconds` elapses,
   flipping `status` to `ready` / `failed`. The request returns `{appId, status: "starting"}`
   immediately; the tab polls. R + Shiny can take tens of seconds to boot and the user must
   keep working meanwhile.

**Stop** — `DELETE /api/v1/apps/{app_id}`, or Cancel from the Jobs panel. `PtyShell.shutdown()`
does a bare `proc.kill()`,
which only reaches the group leader. An R process running Shiny may have forked; Streamlit
spawns a file watcher. So: `os.killpg(os.getpgid(pid), SIGTERM)`, await briefly, then
`SIGKILL`. **Worth fixing in `pty_kernel.py` too** — same latent leak there.

**List** — `GET /api/v1/apps?projectUid=` returns the running apps for the current user,
shaped like `KernelManager.list_for_user()` (`kernel.py:1118-1133`).

**Logs** — `GET /api/v1/apps/{app_id}/logs` returns the tail. Essential: a framework that
fails to boot prints its reason to stderr and nothing else surfaces it.

**Teardown** — `app_manager.shutdown_all()` in the `main.py:114-121` lifespan block, next to
the existing three.

### Idle

`KernelManager._sweep_idle_locked()` (`kernel.py:959-972`) evicts on `idle_seconds()` since
the last *execution*. That measure is meaningless for an app: it is idle by definition
between requests, and busy only while rendering. The right signal is **`last_seen`, bumped by
the proxy on every forwarded request or open WebSocket**. An app nobody has looked at for
`app_idle_timeout_minutes` (default 60) is killed. Sweep opportunistically on every start/list
call, like the kernel manager — no periodic task.

## The proxy

A new router, `apps/api/app/api/v1/routes/apps.py`, mounted under `/api/v1`. `httpx>=0.27` and
`uvicorn[standard]` (hence `websockets`) are **already dependencies** — no new package.

Two catch-all routes:

```
{ANY}  /apps/{app_id}/proxy/{path:path}    → httpx stream to 127.0.0.1:{port}/{path}
{WS}   /apps/{app_id}/ws/{path:path}       → bidirectional pump
```

Rules:
- **Stream, never buffer.** `httpx.AsyncClient.stream()` into a `StreamingResponse`; a
  Streamlit/Gradio app pushes SSE and long-poll, and a buffered proxy hangs them.
- **Forward hop-by-hop headers correctly**: strip `connection`, `keep-alive`,
  `transfer-encoding`, `upgrade` on the way out; pass everything else through, including
  `set-cookie` (Shiny sets a session cookie).
- **WebSocket**: accept, dial the child with `websockets.connect`, then two `asyncio` tasks
  pumping in each direction until either side closes. Shiny and Streamlit are both
  WS-primary; getting this wrong means the app renders once and then freezes.
- **Auth**: `app_id` *is* the bearer. See § Security.
- Bump `last_seen` on every request.

### Path rewriting

The app believes it is at `/`; it is served at `/api/v1/apps/{id}/proxy/`. Absolute-rooted
URLs it emits (`/static/main.js`, `Location: /login`) will miss.

Do the minimum that works, in this order:
1. Inject a `<base href="/api/v1/apps/{id}/proxy/">` into HTML responses. This fixes relative
   URLs, which is most of them.
2. Rewrite `Location` headers on 3xx.
3. Pass the mount point to the app via `LINKR_APP_BASE_PATH` + the preset's own base-path
   flag where one exists (Dash, Streamlit).

**Do not attempt to rewrite JS or CSS bodies.** That is a rabbit hole with no bottom and it is
where a "generic" proxy quietly becomes framework-specific. If an app hardcodes absolute URLs
and ignores `LINKR_APP_BASE_PATH`, it is not supported — document that, don't special-case it.

## Security

This is the part that needs an explicit decision, because it contradicts a rule the codebase
currently states in a comment.

Today all three iframes in the app (`OutputPanel.tsx:326-334`, `CatalogExportTab.tsx:181`,
`JobsIndicator.tsx:233`) use `sandbox="allow-scripts"` **without** `allow-same-origin`, and
`OutputPanel` documents why: a `srcDoc` iframe inherits our origin, so denying
`allow-same-origin` is what stops rendered widget HTML from touching Linkr's `localStorage`.

A web app cannot run under that. It is served from a URL, it needs cookies, storage, and its
own WebSocket. It must be `src=` with same-origin privileges — which means **the app's
JavaScript can read `linkr-access-token` from `localStorage`**.

Two ways to look at it:

- *It changes little.* Whoever writes the app already has `ide:execute`, i.e. arbitrary code
  execution on the server as the API process. Reading their own browser token is a lateral
  move, not an escalation.
- *It changes something.* An app **shared with another user** turns that user's token over to
  its author. That is a real escalation, and it is exactly what "show me your app" would do.

Proposed position: **accept same-origin for now, and refuse to make apps shareable** until an
origin split exists. An app is reachable only by the user who started it (the `app_id` is
theirs), and the UI must not offer a "copy link" affordance. If sharing is ever wanted, it
needs a wildcard-subdomain deployment (`{app_id}.apps.linkr.example`) — worth designing then,
not now.

Other points:
- The `app_id` is the capability. Generate with `secrets.token_urlsafe(32)`; check it against
  the registry **and** against the requesting user on every proxy call. It dies when the app
  is stopped.
- Honour `settings.enable_code_execution` as a kill switch, like `execution.py:107-110`.
- Bind children to `127.0.0.1` explicitly in every preset. A framework defaulting to `0.0.0.0`
  would expose the app on the host network, bypassing every check above.
- Add a `Content-Security-Policy: frame-ancestors 'self'` on proxied responses. There is
  currently **no CSP anywhere in the codebase**, so this is additive and cheap.

## Frontend

**A full tab, not an output panel tab.** `TerminalTab` (`file-store.ts:32-36`, opened via
`openTerminalTab`, rendered by `TerminalPanel.tsx`) is the precedent: a non-file tab sharing
the file tab bar. An app needs the whole viewport, and lives longer than a run — the bottom
`OutputPanel` is the wrong home. `OutputTab.type` stays untouched.

- **Detection** follows the `.Rmd` precedent — `FilesPage.tsx:335-336` is a regex on the
  filename plus a boolean. Name matching (`app.R`, `ui.R`, `plumber.R`) works client-side;
  content matching (`import streamlit`) works on the open buffer. A server-side scan is not
  needed for v1 and would be a new concept in the file tree.
- **Entry point**: a "Run as web app" item in `RunButton`'s dropdown, next to "Run as job"
  and behind the same `serverMode &&` guard (`RunButton.tsx:132-148`). Shown when the file
  matches a preset; a "Run custom command…" variant covers everything else.
- **The tab**: iframe + a thin toolbar — status pill (starting / ready / failed), Restart,
  Stop, "open in new window", and a Logs drawer fed by the logs endpoint. **Closing the tab
  does not stop the app** — it keeps serving, and the Jobs panel is where it is found again.
- **The Jobs panel** (`JobsIndicator`) lists running apps with a Stop action, so an app is
  never orphaned by a closed tab. Clicking one reopens its tab.
- **Client API** in `lib/api/execution.ts` (or a new `lib/api/web-apps.ts`):
  `startWebApp`, `stopWebApp`, `listWebApps`, `webAppLogs` — `runFileAsJob`
  (`execution.ts:104-122`) is the signature to mirror.
- i18n keys in both `en.json` and `fr.json`.

### Dev-mode trap

`vite.config.ts:88-91` sets `Cross-Origin-Embedder-Policy: credentialless` on the dev server.
Prod nginx sends no such header, so this is dev-only — but it will bite immediately, and it
will look like a proxy bug. Either the proxied responses carry a matching
`Cross-Origin-Resource-Policy`, or the COEP header is relaxed in dev. Decide before debugging.

Also: `vite.config.ts:92-101` proxies `/api` **without** `ws: true` (only `/ws` has it). The
terminal WS works by accident of Vite's auto-upgrade; if the app WS misbehaves in dev, add
`ws: true` there.

## Deployment

Nothing to change if the proxy lives under `/api/`. `docker/nginx.conf:31-39` already sets
`proxy_http_version 1.1`, the `Upgrade`/`Connection` pair, and 3600s read/send timeouts —
which is precisely why that prefix is worth keeping. **Add `proxy_buffering off;`** for SSE
and long-poll frameworks.

Child ports stay inside the api container on `127.0.0.1`, so `docker-compose.yml` is untouched.

## New settings (`config.py`)

| Setting | Default | Note |
|---------|---------|------|
| `enable_web_apps` | `True` | separate kill switch, in addition to `enable_code_execution` |
| `app_port_range` | `"8700-8799"` | probed on 127.0.0.1 |
| `max_apps_per_user` | `2` | separate from `max_kernels_per_user` |
| `app_idle_timeout_minutes` | `60` | on `last_seen`, not on execution idleness |
| `app_start_timeout_seconds` | `60` | readiness probe budget; R + Shiny boot is slow |

## Steps

| St | Item | Effort |
|----|------|--------|
| 1. | Extract `runtime_spec()` from `kernel._make()`; kernels build from it, unchanged behaviour (**unit-tested** — pure logic, CLAUDE.md rule) | S |
| 2. | `services/execution/web_apps.py`: `WebApp` + `AppManager` (detached spawn, port probe, **background** readiness probe, log tail, killpg teardown, quota, idle sweep) + `shutdown_all` in the lifespan. Fix the same killpg leak in `pty_kernel.py` | M |
| 3. | Presets table + detection (name + content regex) + custom command with `$PORT` (**unit-tested**) | S |
| 4. | `routes/apps.py`: start / stop / list / logs, gated by `ide:execute` + both kill switches | S |
| 5. | Job-row shadow: `kind="app"` insert/update + log tail + a cancel hook in `jobs.cancel()` reaching `AppManager.stop()` | S |
| 6. | The proxy: HTTP streaming + WebSocket pump + `<base>` injection + `Location` rewriting + `frame-ancestors` | M |
| 7. | Frontend: `AppTab` in the file store, the tab view (iframe + toolbar + logs drawer), `RunButton` entry, running apps in `JobsIndicator`, client API, i18n | M |
| 8. | nginx `proxy_buffering off`; settle the dev COEP question; `docs/architecture.md` section | S |
| 9. | Manual matrix: Shiny, Streamlit, Dash, Gradio, plumber, FastAPI — boot, interact, WS, restart, idle kill, quota, **and that the R/Python session stays usable throughout** | M |

Steps 1–4 and 6 give a working app reachable by URL; 7 makes it usable; 5 is what keeps a
closed tab from orphaning a process. 9 is not optional — the whole design rests on the claim
that one proxy serves every framework, and only the matrix tests that claim.

## Open points

- **Multiple apps per project.** The quota allows 2 per *user*; is a second app on the same
  project a legitimate case, or an accident to prevent?
- **Dashboard embedding.** A Shiny app as a dashboard widget is the obvious follow-on, and it
  reopens sharing — a dashboard is viewed by people who did not start the app. Deliberately
  out of scope here; it needs the origin split first.
- **Restart on file save.** Streamlit and Shiny both watch files themselves. Do we let them,
  or force restart from the toolbar? Letting them is less code and matches expectations.
- **`git`-linked projects.** An app started from a working copy, then a pull — the app holds
  the old code until restarted. Probably acceptable; worth a note in the UI.
- **Resource ceiling.** Nothing here bounds an app's memory or CPU. The kernels have the same
  gap, so this is not a regression, but a runaway app is a longer-lived problem than a runaway
  cell.
