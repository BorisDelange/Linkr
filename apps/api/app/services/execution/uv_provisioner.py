"""Provision a project's Python environment with `uv` (managed envs, step 3).

An environment's declarative spec lives on disk under ``environments/python/``
(``pyproject.toml`` + ``uv.lock``), versioned in the project git. The materialised
venv lives under ``.cache/envs/python`` (machine-local, git-ignored) and is built
from the lockfile, pulling package bytes from the Linkr-wide uv cache so a version
already present for another project is not re-downloaded.

Everything here shells out to ``uv`` and runs blocking → callers invoke it in a
thread executor (see ``build``), never on the event loop. Package edits are
declarative: add/remove rewrites ``pyproject.toml`` and re-locks; the venv is
(re)materialised by ``build`` (a manual, explicit step — never automatic).
"""

import asyncio
import subprocess
import tomllib
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from app.config import settings
from app.services import project_fs
from app.services.execution import env_options
from app.services.execution.child_env import child_env
from app.services.execution.package_spec import validate_package_spec

# A hung `uv` (network black-hole resolving against the index) must not pin a
# worker / build slot forever. Package-edit commands are quick manifest re-locks.
_UV_EDIT_TIMEOUT = 120


class ProvisionError(Exception):
    """A uv command failed; carries the combined stdout/stderr for the caller."""


@dataclass
class BuildResult:
    ok: bool
    log: str


def _pyproject_path(project_uid: str) -> Path:
    return project_fs.env_spec_dir(project_uid, "python") / "pyproject.toml"


def _lock_path(project_uid: str) -> Path:
    return project_fs.env_spec_dir(project_uid, "python") / "uv.lock"


def _venv_dir(project_uid: str) -> Path:
    return project_fs.env_cache_dir(project_uid, "python")


def venv_python(project_uid: str) -> Path:
    """Absolute path of the env's interpreter (POSIX layout; Windows uses Scripts/).
    Existence is not guaranteed — call ``is_built`` first."""
    venv = _venv_dir(project_uid)
    posix = venv / "bin" / "python"
    return posix if posix.exists() else venv / "Scripts" / "python.exe"


def is_built(project_uid: str) -> bool:
    return venv_python(project_uid).exists()


_DEFAULT_PYPROJECT = """\
[project]
name = "linkr-project-env"
version = "0.0.0"
description = "Linkr project Python environment"
requires-python = ">=3.10"
dependencies = []
"""


def ensure_manifest(project_uid: str) -> Path:
    """Create a minimal ``pyproject.toml`` if the env has none yet, so add/lock has
    something to work against. Idempotent."""
    path = _pyproject_path(project_uid)
    if not path.exists():
        path.write_text(_DEFAULT_PYPROJECT)
    return path


def list_packages(project_uid: str) -> list[dict]:
    """Declared dependencies, read from the manifest (name + version spec). The
    lockfile has the full resolved tree; the manifest is what the user chose."""
    path = _pyproject_path(project_uid)
    if not path.exists():
        return []
    data = tomllib.loads(path.read_text())
    deps = data.get("project", {}).get("dependencies", []) or []
    return [_split_requirement(d) for d in deps]


def check_updates(project_uid: str, options: dict | None = None) -> dict[str, str]:
    """Which installed packages have a newer version on the index → {name: latest}.
    Not implemented for Python yet (uv has no stable single-shot outdated query across
    versions); returns empty so the shared endpoint works. R is supported today."""
    return {}


def _split_requirement(req: str) -> dict:
    for sep in ("==", ">=", "<=", "~=", ">", "<", "!="):
        if sep in req:
            name, _, spec = req.partition(sep)
            return {"name": name.strip(), "spec": sep + spec.strip()}
    return {"name": req.strip(), "spec": ""}


def _uv_env(project_uid: str, options: dict | None = None) -> dict[str, str]:
    """The environment for a uv subprocess: shared cache + the project venv, plus
    the resolved install options (index URL, trusted host for an internal mirror
    with a self-signed cert). Falls back to the server-wide index."""
    options = options or {}
    env = {
        **_base_env(),
        "UV_CACHE_DIR": str(project_fs.env_package_cache("uv")),
        "UV_PROJECT_ENVIRONMENT": str(_venv_dir(project_uid)),
        "UV_INDEX_URL": options.get("indexUrl") or settings.pip_index_url,
    }
    trusted = options.get("trustedHost")
    if trusted:
        # uv honours pip's trusted-host to skip TLS verification for an internal
        # mirror (self-signed cert behind a corporate proxy).
        env["UV_INSECURE_HOST"] = trusted
    if env_options.confined_hosts("python", options):
        # Under a mirror the index is the deployment's alone: the project's own
        # pyproject cannot name another one, nor pin a package to another source.
        env["UV_NO_CONFIG"] = "1"
        env["UV_NO_SOURCES"] = "1"
    return env


def _require_mirror_sources(project_uid: str, options: dict | None, *, lock_too: bool) -> None:
    """Under a deployment mirror, refuse a manifest requirement or, before a sync
    (which fetches a locked URL as written), a lockfile source that downloads from
    a host outside it. A re-lock resolves against the mirror alone, so it is how a
    lock from elsewhere is brought onto it."""
    allowed = env_options.confined_hosts("python", options or {})
    if not allowed:
        return
    outside: set[str] = set()
    manifest, lock = _pyproject_path(project_uid), _lock_path(project_uid)
    if manifest.exists():
        for req in _manifest_requirements(tomllib.loads(manifest.read_text())):
            reference = req.split(";", 1)[0].partition("@")[2].strip()
            if reference:
                outside |= _hosts_outside(reference, allowed)
    if lock_too and lock.exists():
        for url in _lock_urls(tomllib.loads(lock.read_text())):
            outside |= _hosts_outside(url, allowed)
    if outside:
        raise ProvisionError(
            "This environment's pyproject.toml or uv.lock downloads from outside the deployment's "
            f"package mirror ({', '.join(sorted(outside))}). Remove those sources, or update all "
            "packages to lock them again on the mirror."
        )


def _manifest_requirements(data: dict) -> list[str]:
    project = data.get("project") or {}
    groups = [project.get("dependencies") or [], *(project.get("optional-dependencies") or {}).values(),
              *(data.get("dependency-groups") or {}).values(), (data.get("build-system") or {}).get("requires") or []]
    return [req for group in groups if isinstance(group, list) for req in group if isinstance(req, str)]


def _lock_urls(node) -> list[str]:
    if isinstance(node, dict):
        found = [v for k, v in node.items() if k in ("url", "registry", "git") and isinstance(v, str)]
        return found + [u for v in node.values() for u in _lock_urls(v)]
    if isinstance(node, list):
        return [u for v in node for u in _lock_urls(v)]
    return []


def _hosts_outside(url: str, allowed: set[str]) -> set[str]:
    """{the host of `url`} unless it is an http(s) URL on an allowed host; a URL of
    another scheme (file:, ssh:) never goes through the mirror."""
    parts = urlsplit(url.removeprefix("git+"))
    host = (parts.hostname or "").lower()
    if parts.scheme in ("http", "https") and host in allowed:
        return set()
    return {host or url}


def _run(project_uid: str, args: list[str], on_log=None, options: dict | None = None) -> str:
    """Run a uv command in the env's spec dir with the shared cache configured.
    Returns combined output; raises ProvisionError with the output on failure.
    ``on_log`` (if given) receives the exact command line and its output so a job
    can surface both — the user sees precisely what ran and why it failed."""
    spec_dir = project_fs.env_spec_dir(project_uid, "python")
    _require_mirror_sources(project_uid, options, lock_too=False)
    env = _uv_env(project_uid, options)
    cmdline = f"$ {settings.uv_bin} {' '.join(args)}"
    if on_log is not None:
        on_log(cmdline)
    try:
        proc = subprocess.run(
            [settings.uv_bin, *args],
            cwd=str(spec_dir),
            env=env,
            capture_output=True,
            text=True,
            timeout=_UV_EDIT_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        raise ProvisionError(f"{cmdline}\nuv {' '.join(args)} timed out")
    out = (proc.stdout or "") + (proc.stderr or "")
    if on_log is not None and out.strip():
        on_log(out.rstrip())
    if proc.returncode != 0:
        # Prefix the command so the job log shows what ran, then the real output.
        raise ProvisionError(f"{cmdline}\n{out.strip()}" if out.strip() else f"{cmdline}\nuv {' '.join(args)} failed")
    return out


def _base_env() -> dict[str, str]:
    # PATH etc. so `uv` finds its managed pythons; never an ambient VIRTUAL_ENV,
    # which would make uv target the caller's venv instead of ours.
    return child_env(provision=True)


def add_packages(project_uid: str, packages: list[str], on_log=None, options: dict | None = None) -> None:
    """Add dependencies: rewrite the manifest and re-lock (no venv build yet)."""
    ensure_manifest(project_uid)
    safe = [validate_package_spec(p) for p in packages]
    # `--` so a package name is never parsed as a uv flag (allowlist already bans
    # a leading dash, but keep the argv boundary explicit).
    _run(project_uid, ["add", "--no-sync", "--", *safe], on_log=on_log, options=options)


def remove_package(project_uid: str, package: str, on_log=None, options: dict | None = None) -> None:
    """Remove a dependency: rewrite the manifest and re-lock (no venv build yet)."""
    ensure_manifest(project_uid)
    _run(project_uid, ["remove", "--no-sync", "--", validate_package_spec(package)], on_log=on_log, options=options)


def upgrade(project_uid: str, package: str | None = None, on_log=None, options: dict | None = None) -> None:
    """Re-lock to newer versions: one package (``uv lock --upgrade-package X``) or
    all (``uv lock --upgrade``). Re-lock only — the user builds to materialise."""
    ensure_manifest(project_uid)
    if package:
        args = ["lock", "--upgrade-package", validate_package_spec(package)]
    else:
        args = ["lock", "--upgrade"]
    _run(project_uid, args, on_log=on_log, options=options)


async def build(project_uid: str, on_log=None, options: dict | None = None) -> BuildResult:
    """Materialise the venv from the lockfile as an async subprocess (`uv sync`),
    so it doesn't block the event loop (uvicorn is 1 worker) AND can be killed on
    cancel. Streams lines to ``on_log`` if given. Cancelling the awaiting task
    terminates the uv process (see the CancelledError handler)."""
    ensure_manifest(project_uid)
    spec_dir = project_fs.env_spec_dir(project_uid, "python")
    try:
        _require_mirror_sources(project_uid, options, lock_too=True)
    except ProvisionError as e:
        return BuildResult(ok=False, log=str(e))
    env = _uv_env(project_uid, options)
    if on_log is not None:
        on_log(f"$ {settings.uv_bin} sync")
    proc = await asyncio.create_subprocess_exec(
        settings.uv_bin, "sync",
        cwd=str(spec_dir),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    lines: list[str] = []

    async def _stream() -> int:
        assert proc.stdout is not None
        async for raw in proc.stdout:
            line = raw.decode("utf-8", "replace").rstrip()
            lines.append(line)
            if on_log is not None:
                on_log(line)
        return await proc.wait()

    try:
        code = await asyncio.wait_for(_stream(), timeout=settings.build_timeout_seconds)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        lines.append(f"Build timed out after {settings.build_timeout_seconds}s")
        return BuildResult(ok=False, log="\n".join(lines))
    except asyncio.CancelledError:
        proc.kill()
        await proc.wait()
        raise
    log = "\n".join(lines)
    return BuildResult(ok=(code == 0), log=log)
