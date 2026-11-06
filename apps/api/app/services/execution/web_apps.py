"""Web apps started from the IDE: Shiny, Streamlit, Dash, Gradio, plumber… run as
long-lived processes and shown in Linkr through its own reverse proxy
(routes/apps.py), the way code-server, jupyter-server-proxy and RStudio Server do.

An app listens on 127.0.0.1 inside the API's machine and is reached only at
`<public prefix>/api/v1/apps/<id>/proxy/`, the same origin and port as the rest of
Linkr. Nothing has to be opened in an SPE firewall or gateway, which is the point:
SPEs publish one HTTP entry per project and no other port.

Linkr does not know what Shiny is. A framework is a preset — how to recognise a
file, how to launch it with a port — and the runtime treats every app as a process
that will eventually listen on its port. The custom command (`$PORT`) is the
primitive the presets are a convenience over.

An app is never run by a kernel: it is its own process group, so the R/Python
console it was written in stays free while it serves. Its lifetime is bounded by
idle eviction (no request through the proxy for a while), never by a run timeout.
"""

import asyncio
import os
import re
import secrets
import shlex
import signal
import socket
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

from app.config import settings
from app.services.execution import jobs
from app.services.execution.child_env import child_env
from app.services.execution.kernel import R_LIB_SETUP, RuntimeSpec

# ── Presets ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Preset:
    """`command`: for Python, the arguments after the interpreter; for R, one R
    expression run after the project's library setup. Placeholders: {file} {dir}
    {port} {base_path} (the public path the browser sees, trailing slash), quoted
    for the target language by `launch_argv`. `env` takes the same placeholders,
    for frameworks that read their mount point from the environment."""

    key: str
    label: str
    language: str
    command: tuple[str, ...] | str
    names: tuple[str, ...] = ()
    content: str | None = None
    env: dict[str, str] = field(default_factory=dict)


PRESETS: tuple[Preset, ...] = (
    Preset(
        key="shiny", label="Shiny", language="r",
        names=("app.R", "ui.R", "server.R"), content=r"\bshinyApp\s*\(",
        command=(
            "shiny::runApp(if (basename({file}) %in% c('app.R', 'ui.R', 'server.R')) {dir}"
            " else shiny::shinyAppFile({file}), port = {port}, host = '127.0.0.1',"
            " launch.browser = FALSE)"
        ),
    ),
    Preset(
        key="plumber", label="plumber", language="r",
        names=("plumber.R",), content=r"^\s*#\*\s*@(get|post|put|delete|apiTitle)\b",
        command="plumber::pr_run(plumber::pr({file}), port = {port}, host = '127.0.0.1')",
    ),
    Preset(
        key="shiny-python", label="Shiny for Python", language="python",
        content=r"^\s*(from\s+shiny(\.express)?\s+import|import\s+shiny)\b",
        command=("-m", "shiny", "run", "--host", "127.0.0.1", "--port", "{port}", "{file}"),
    ),
    # Streamlit's page finds its server from its own URL, so it needs no base path.
    Preset(
        key="streamlit", label="Streamlit", language="python",
        content=r"^\s*(import\s+streamlit|from\s+streamlit\s+import)\b",
        command=(
            "-m", "streamlit", "run", "{file}", "--server.port", "{port}",
            "--server.address", "127.0.0.1", "--server.headless", "true",
            "--browser.gatherUsageStats", "false", "--client.toolbarMode", "minimal",
        ),
    ),
    # Dash reads HOST/PORT and its request prefix from the environment when the
    # script calls app.run() without them.
    Preset(
        key="dash", label="Dash", language="python",
        content=r"\bDash\s*\(",
        command=("{file}",),
        env={"DASH_REQUESTS_PATHNAME_PREFIX": "{base_path}"},
    ),
    Preset(
        key="gradio", label="Gradio", language="python",
        content=r"^\s*(import\s+gradio|from\s+gradio\s+import)\b",
        command=("{file}",),
        env={
            "GRADIO_SERVER_NAME": "127.0.0.1", "GRADIO_SERVER_PORT": "{port}",
            "GRADIO_ROOT_PATH": "{base_path}", "GRADIO_ANALYTICS_ENABLED": "False",
        },
    ),
    Preset(
        key="panel", label="Panel", language="python",
        content=r"^\s*(import\s+panel|from\s+panel\s+import)\b",
        command=(
            "-m", "panel", "serve", "{file}", "--address", "127.0.0.1", "--port", "{port}",
            "--allow-websocket-origin", "*",
        ),
    ),
    Preset(
        key="fastapi", label="FastAPI", language="python",
        content=r"\bFastAPI\s*\(",
        command=(
            "-m", "uvicorn", "{module}:app", "--host", "127.0.0.1", "--port", "{port}",
            "--root-path", "{base_path}",
        ),
    ),
    Preset(
        key="flask", label="Flask", language="python",
        content=r"\bFlask\s*\(",
        command=("-m", "flask", "--app", "{file}", "run", "--host", "127.0.0.1", "--port", "{port}"),
    ),
)

_BY_KEY = {p.key: p for p in PRESETS}
_LANGUAGE_OF = {".r": "r", ".py": "python"}


def language_of(path: str) -> str | None:
    return _LANGUAGE_OF.get(Path(path).suffix.lower())


def detect(path: str, content: str) -> Preset | None:
    """The preset a file is an entry point of: by name first, then by content.
    Shiny for Python before Streamlit/Dash, whose patterns it does not share."""
    language = language_of(path)
    name = Path(path).name
    candidates = [p for p in PRESETS if p.language == language]
    for p in candidates:
        if name in p.names:
            return p
    for p in candidates:
        if p.content and re.search(p.content, content, re.MULTILINE):
            return p
    return None


def preset(key: str) -> Preset | None:
    return _BY_KEY.get(key)


def _r_string(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _values(file: Path, port: int, base_path: str) -> dict[str, str]:
    return {
        "file": str(file), "dir": str(file.parent), "port": str(port),
        "base_path": base_path, "module": file.stem,
    }


def launch_command(p: Preset, file: Path, port: int, base_path: str) -> list[str] | str:
    """A Python preset's arguments, or an R preset's expression, filled in."""
    values = _values(file, port, base_path)
    if p.language == "r":
        assert isinstance(p.command, str)
        quoted = {k: (v if k == "port" else _r_string(v)) for k, v in values.items()}
        return p.command.format(**quoted)
    assert isinstance(p.command, tuple)
    return [arg.format(**values) for arg in p.command]


def launch_argv(
    p: Preset, spec: RuntimeSpec, file: Path, port: int, base_path: str, launcher_dir: Path
) -> list[str]:
    """The argv of a preset's process. An R app runs from a launcher file, never
    `Rscript -e`: the library isolation (R_LIB_SETUP) must run first, and `-e`
    truncates long programs."""
    command = launch_command(p, file, port, base_path)
    if isinstance(command, str):
        launcher_dir.mkdir(parents=True, exist_ok=True)
        launcher = launcher_dir / "launch.R"
        launcher.write_text(R_LIB_SETUP + command + "\n", encoding="utf-8")
        return [spec.interpreter, "--vanilla", str(launcher)]
    return [spec.interpreter, *command]


def custom_argv(command: str) -> list[str]:
    """A user command, run by bash with $PORT in its environment. The project's
    interpreter comes first on PATH (see `app_env`), so `streamlit run x.py`
    resolves to the project environment; an R one gets its library through
    `custom_r_profile`."""
    return ["bash", "-c", command]


def custom_r_profile(launcher_dir: Path) -> dict[str, str]:
    """`Rscript app.R` started by a custom command reads R_PROFILE_USER, so it
    sees the project's library exactly as the console does. (`--vanilla` would
    skip it — and the project's isolation with it.)"""
    launcher_dir.mkdir(parents=True, exist_ok=True)
    profile = launcher_dir / "Rprofile"
    profile.write_text(R_LIB_SETUP, encoding="utf-8")
    return {"R_PROFILE_USER": str(profile)}


# ── Runtime ──────────────────────────────────────────────────────────────────

LOG_LINES = 500
# Ended apps stay readable for a while, so the tab can say why one stopped.
_ENDED_KEPT = 20
# Flushing every line to the job row would hammer the database for a chatty app.
_LOG_FLUSH_SECONDS = 2.0
_STOP_GRACE_SECONDS = 3.0
_SWEEP_SECONDS = 60.0
# Written beside an app's launcher, so a restarted API can find the process
# groups its previous run left behind (start_new_session outlives a crash).
_PID_FILE = "pid"


def _apps_cache() -> Path:
    return settings.data_path / ".cache" / "web-apps"


@dataclass
class WebApp:
    app_id: str  # unguessable: it is also the capability the proxy checks
    project_uid: str
    user_id: int
    label: str
    path: str  # relative to the project's scripts/
    framework: str  # preset key or "custom"; display and argv only
    command: str  # what runs, as shown to the user
    port: int
    base_path: str
    job_id: str
    proc: asyncio.subprocess.Process
    started_at: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.monotonic)
    status: str = "starting"  # starting | ready | failed | stopped
    error: str | None = None
    log: deque[str] = field(default_factory=lambda: deque(maxlen=LOG_LINES))
    task: asyncio.Task | None = None
    # The names of the cookies the app has set: the only ones the proxy hands back.
    cookie_names: set[str] = field(default_factory=set)
    # A browser session opened before this instant (µs since the epoch) has ended.
    sessions_from_us: int = 0

    def touch(self) -> None:
        self.last_seen = time.monotonic()

    def public(self) -> dict:
        return {
            "appId": self.app_id,
            "projectUid": self.project_uid,
            "label": self.label,
            "path": self.path,
            "framework": self.framework,
            "command": self.command,
            "status": self.status,
            "error": self.error,
            "url": self.base_path,
            "jobId": self.job_id,
            "startedAt": self.started_at,
        }


class AppLimitReached(Exception):
    pass


class AppStartError(Exception):
    pass


def _port_range() -> range:
    lo, _, hi = settings.app_port_range.partition("-")
    return range(int(lo), int(hi or lo) + 1)


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def _is_our_app(pid: int, app_id: str) -> bool:
    """Proof that `pid` is still the app started under `app_id`, not a process
    that reused its number: the environment Linkr gave it. Only Linux exposes
    another process's environment; elsewhere nothing is proven."""
    try:
        environ = Path(f"/proc/{pid}/environ").read_bytes()
    except OSError:
        return False
    return f"LINKR_APP_ID={app_id}".encode() in environ.split(b"\0")


def reap_orphans() -> int:
    """Kill the app process groups a previous API process left running, when they
    are provably Linkr's; the others keep their ports, which `_allocate_port`
    skips. Run at startup, before any app of this process exists."""
    reaped = 0
    root = _apps_cache()
    if not root.is_dir():
        return 0
    for pid_file in root.glob(f"*/{_PID_FILE}"):
        app_id = pid_file.parent.name
        try:
            pid = int(pid_file.read_text().strip())
        except (OSError, ValueError):
            pid = 0
        if pid > 0 and _is_our_app(pid, app_id):
            try:
                os.killpg(pid, signal.SIGKILL)
                reaped += 1
            except (ProcessLookupError, PermissionError):
                pass
        pid_file.unlink(missing_ok=True)
    return reaped


def _kill_group(proc: asyncio.subprocess.Process, sig: int) -> None:
    # The app runs in its own session (start_new_session), so its group holds
    # everything it forked: R's workers, Streamlit's file watcher, uvicorn's reloader.
    try:
        os.killpg(proc.pid, sig)
    except (ProcessLookupError, PermissionError):
        pass


def app_env(spec: RuntimeSpec, port: int, base_path: str, extra: dict[str, str]) -> dict[str, str]:
    """From the same allowlist as a kernel's (child_env): an app runs code its
    author wrote, and must not inherit the API's secrets."""
    env = child_env(spec.env)
    interpreter_dir = os.path.dirname(spec.interpreter)
    if interpreter_dir:
        env["PATH"] = interpreter_dir + os.pathsep + env.get("PATH", "")
    env.update({
        "PORT": str(port),
        "HOST": "127.0.0.1",
        "LINKR_APP_BASE_PATH": base_path,
        "PYTHONUNBUFFERED": "1",
    })
    env.update(extra)
    return env


class AppManager:
    """Running apps, keyed by their id. The source of truth for what runs; the
    `kind="app"` job row only mirrors it for the jobs panel, whose Cancel reaches
    the app by cancelling its watcher task (jobs.adopt)."""

    def __init__(self) -> None:
        self._apps: dict[str, WebApp] = {}
        self._ended: dict[str, WebApp] = {}
        self._lock = asyncio.Lock()

    def get(self, app_id: str) -> WebApp | None:
        """A running app, or one that ended recently (status failed/stopped)."""
        return self._apps.get(app_id) or self._ended.get(app_id)

    def running(self, app_id: str) -> WebApp | None:
        app = self._apps.get(app_id)
        return app if app is not None and app.status in ("starting", "ready") else None

    def list_for_user(self, project_uid: str, user_id: int) -> list[WebApp]:
        self.sweep_idle()
        return [
            a for a in self._apps.values()
            if a.project_uid == project_uid and a.user_id == user_id
        ]

    def end_sessions(self, user_id: int) -> list[WebApp]:
        """End every browser session opened on a user's apps; returns those apps."""
        apps = [a for a in self._apps.values() if a.user_id == user_id]
        now = time.time_ns() // 1000
        for app in apps:
            app.sessions_from_us = now
        return apps

    def stop_for_user(self, user_id: int) -> None:
        for app in [a for a in self._apps.values() if a.user_id == user_id]:
            self.stop(app.app_id)

    def _count_for_user(self, user_id: int) -> int:
        return sum(1 for a in self._apps.values() if a.user_id == user_id)

    def _allocate_port(self) -> int:
        taken = {a.port for a in self._apps.values()}
        for port in _port_range():
            if port not in taken and _port_free(port):
                return port
        raise AppStartError(f"No free port in {settings.app_port_range}.")

    def sweep_idle(self) -> None:
        limit = settings.app_idle_timeout_minutes * 60
        now = time.monotonic()
        for app in list(self._apps.values()):
            if now - app.last_seen > limit:
                self._log(app, f"[linkr] Stopped after {settings.app_idle_timeout_minutes} min without a visit.")
                self.stop(app.app_id)

    async def start(
        self,
        db,
        *,
        project_uid: str,
        user_id: int,
        path: str,
        file: Path,
        language: str,
        spec: RuntimeSpec,
        public_prefix: str,
        preset_key: str | None,
        command: str | None,
        app_id: str | None = None,
    ) -> WebApp:
        """Spawn the app and return at once, status `starting`: a background probe
        flips it to `ready` when its port accepts a connection."""
        async with self._lock:
            self.sweep_idle()
            if self._count_for_user(user_id) >= settings.max_apps_per_user:
                raise AppLimitReached(
                    f"Web app limit reached ({settings.max_apps_per_user}). Stop one to start another."
                )
            port = self._allocate_port()
            app_id = app_id or secrets.token_urlsafe(24)
            base_path = f"{public_prefix}/api/v1/apps/{app_id}/proxy/"
            launcher_dir = _apps_cache() / app_id
            if command:
                framework = "custom"
                extra_env = custom_r_profile(launcher_dir) if language == "r" else {}
                argv = custom_argv(command)
                shown = command
            else:
                p = preset(preset_key or "")
                if p is None:
                    raise AppStartError(f"Unknown framework: {preset_key}")
                framework = p.key
                values = _values(file, port, base_path)
                extra_env = {k: v.format(**values) for k, v in p.env.items()}
                argv = launch_argv(p, spec, file, port, base_path, launcher_dir)
                filled = launch_command(p, file, port, base_path)
                shown = filled if isinstance(filled, str) else shlex.join(["python", *filled])
            env = app_env(spec, port, base_path, {**extra_env, "LINKR_APP_ID": app_id})
            try:
                proc = await asyncio.create_subprocess_exec(
                    *argv,
                    cwd=str(file.parent),
                    env=env,
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    start_new_session=True,
                )
            except OSError as e:
                raise AppStartError(f"Could not start {argv[0]}: {e}") from e
            try:
                launcher_dir.mkdir(parents=True, exist_ok=True)
                (launcher_dir / _PID_FILE).write_text(str(proc.pid))
            except OSError:
                pass
            try:
                job = await jobs.create(
                    db, project_uid, user_id, kind="app", label=file.name, input=shown,
                )
            except BaseException:
                _kill_group(proc, signal.SIGKILL)
                raise
            app = WebApp(
                app_id=app_id, project_uid=project_uid, user_id=user_id, label=file.name,
                path=path, framework=framework, command=shown, port=port,
                base_path=base_path, job_id=job.id, proc=proc,
            )
            self._apps[app_id] = app
        app.task = asyncio.create_task(self._watch(app))
        await jobs.adopt(job.id, app.task)
        await jobs.JobHandle(job.id).set_result({"appId": app_id, "url": base_path})
        return app

    def stop(self, app_id: str) -> bool:
        """Cancel the app's watcher, which takes its process group down."""
        app = self._apps.get(app_id)
        if app is None or app.task is None or app.task.done():
            return False
        if app.status != "failed":
            app.status = "stopped"
        app.task.cancel()
        return True

    async def shutdown_all(self) -> None:
        for app in list(self._apps.values()):
            if app.task is not None and not app.task.done():
                app.task.cancel()
        tasks = [a.task for a in self._apps.values() if a.task is not None]
        await asyncio.gather(*tasks, return_exceptions=True)

    @staticmethod
    def _log(app: WebApp, line: str) -> None:
        app.log.append(line)

    async def _watch(self, app: WebApp) -> None:
        """The app's whole life, as the job's task. Returns when the process exits
        on its own (an error if it failed); cancelled to stop it."""
        probe = asyncio.create_task(self._probe(app))
        try:
            async with jobs.live_log(jobs.JobHandle(app.job_id), _LOG_FLUSH_SECONDS) as on_log:
                try:
                    await self._pump(app, on_log)
                    code = await app.proc.wait()
                except asyncio.CancelledError:
                    if app.status != "failed":
                        app.status = "stopped"
                    await self._terminate(app)
                    raise
            if app.status == "stopped":
                return
            app.status = "failed"
            tail = "\n".join(list(app.log)[-30:])
            app.error = f"The app exited (code {code})."
            raise AppStartError(f"{app.error}\n{tail}".strip())
        finally:
            probe.cancel()
            (_apps_cache() / app.app_id / _PID_FILE).unlink(missing_ok=True)
            self._apps.pop(app.app_id, None)
            self._ended[app.app_id] = app
            while len(self._ended) > _ENDED_KEPT:
                self._ended.pop(next(iter(self._ended)))

    @staticmethod
    async def _pump(app: WebApp, on_log) -> None:
        # Chunks, not readline(): a line longer than the stream's limit (a
        # minified bundle printed by mistake) would raise and stop the pump.
        assert app.proc.stdout is not None
        partial = ""
        while True:
            chunk = await app.proc.stdout.read(65536)
            if not chunk:
                if partial:
                    app.log.append(partial)
                    on_log(partial)
                return
            *lines, partial = (partial + chunk.decode("utf-8", "replace")).split("\n")
            app.log.extend(lines)
            for line in lines:
                on_log(line)

    async def _terminate(self, app: WebApp) -> None:
        if app.proc.returncode is not None:
            return
        _kill_group(app.proc, signal.SIGTERM)
        try:
            await asyncio.wait_for(asyncio.shield(app.proc.wait()), _STOP_GRACE_SECONDS)
        except asyncio.TimeoutError:
            _kill_group(app.proc, signal.SIGKILL)
            await app.proc.wait()

    async def _probe(self, app: WebApp) -> None:
        deadline = time.monotonic() + settings.app_start_timeout_seconds
        while time.monotonic() < deadline and app.proc.returncode is None:
            try:
                _, writer = await asyncio.wait_for(
                    asyncio.open_connection("127.0.0.1", app.port), timeout=2
                )
            except (OSError, asyncio.TimeoutError):
                await asyncio.sleep(0.5)
                continue
            writer.close()
            app.status = "ready"
            app.touch()
            return
        if app.proc.returncode is None:
            app.status = "failed"
            app.error = (
                f"Nothing answered on the app's port after {settings.app_start_timeout_seconds}s. "
                "It must listen on 127.0.0.1:$PORT."
            )
            self._log(app, f"[linkr] {app.error}")
            self.stop(app.app_id)


manager = AppManager()


async def run_idle_sweeper() -> None:
    """Stop idle apps on a timer, not only when someone lists or starts one: an
    app nobody looks at any more is exactly the one nobody lists."""
    while True:
        await asyncio.sleep(_SWEEP_SECONDS)
        manager.sweep_idle()
