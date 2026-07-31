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

from app.config import settings
from app.services import project_fs


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


def _split_requirement(req: str) -> dict:
    for sep in ("==", ">=", "<=", "~=", ">", "<", "!="):
        if sep in req:
            name, _, spec = req.partition(sep)
            return {"name": name.strip(), "spec": sep + spec.strip()}
    return {"name": req.strip(), "spec": ""}


def _run(project_uid: str, args: list[str]) -> str:
    """Run a uv command in the env's spec dir with the shared cache configured.
    Returns combined output; raises ProvisionError with the output on failure."""
    spec_dir = project_fs.env_spec_dir(project_uid, "python")
    env = {
        **_base_env(),
        "UV_CACHE_DIR": str(project_fs.env_package_cache("uv")),
        "UV_PROJECT_ENVIRONMENT": str(_venv_dir(project_uid)),
        "UV_INDEX_URL": settings.pip_index_url,
    }
    proc = subprocess.run(
        [settings.uv_bin, *args],
        cwd=str(spec_dir),
        env=env,
        capture_output=True,
        text=True,
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        raise ProvisionError(out.strip() or f"uv {' '.join(args)} failed")
    return out


def _base_env() -> dict[str, str]:
    import os

    # Inherit PATH etc. so `uv` finds its managed pythons, but drop any ambient
    # VIRTUAL_ENV that would make uv target the caller's venv instead of ours.
    env = {k: v for k, v in os.environ.items() if k != "VIRTUAL_ENV"}
    return env


def add_packages(project_uid: str, packages: list[str]) -> None:
    """Add dependencies: rewrite the manifest and re-lock (no venv build yet)."""
    ensure_manifest(project_uid)
    _run(project_uid, ["add", "--no-sync", *packages])


def remove_package(project_uid: str, package: str) -> None:
    """Remove a dependency: rewrite the manifest and re-lock (no venv build yet)."""
    ensure_manifest(project_uid)
    _run(project_uid, ["remove", "--no-sync", package])


async def build(project_uid: str, on_log=None) -> BuildResult:
    """Materialise the venv from the lockfile as an async subprocess (`uv sync`),
    so it doesn't block the event loop (uvicorn is 1 worker) AND can be killed on
    cancel. Streams lines to ``on_log`` if given. Cancelling the awaiting task
    terminates the uv process (see the CancelledError handler)."""
    ensure_manifest(project_uid)
    spec_dir = project_fs.env_spec_dir(project_uid, "python")
    env = {
        **_base_env(),
        "UV_CACHE_DIR": str(project_fs.env_package_cache("uv")),
        "UV_PROJECT_ENVIRONMENT": str(_venv_dir(project_uid)),
        "UV_INDEX_URL": settings.pip_index_url,
    }
    proc = await asyncio.create_subprocess_exec(
        settings.uv_bin, "sync",
        cwd=str(spec_dir),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    lines: list[str] = []
    try:
        assert proc.stdout is not None
        async for raw in proc.stdout:
            line = raw.decode("utf-8", "replace").rstrip()
            lines.append(line)
            if on_log is not None:
                on_log(line)
        code = await proc.wait()
    except asyncio.CancelledError:
        proc.kill()
        await proc.wait()
        raise
    log = "\n".join(lines)
    return BuildResult(ok=(code == 0), log=log)
