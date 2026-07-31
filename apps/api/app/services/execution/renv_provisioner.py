"""Provision a project's R environment with `renv` (managed R envs, step 5).

Mirrors the uv provisioner's shape so ``environments.py`` treats both languages
alike. The declarative spec lives under ``environments/r/`` (``renv.lock`` +
``.Rprofile``), versioned in the project git. The private library lives under
``.cache/envs/r`` (machine-local, git-ignored), built from the lockfile and made
of links into the Linkr-wide renv cache — so a package version installed for one
project is reused by the next.

Everything shells out to ``Rscript``. Package edits are declarative: add/remove
edits the lockfile via ``renv::record``/``renv::remove`` + ``renv::snapshot``; the
library is (re)materialised by ``build`` (``renv::restore``), a manual step.
"""

import asyncio
import json
from dataclasses import dataclass
from pathlib import Path

from app.config import settings
from app.services import project_fs


class ProvisionError(Exception):
    """An Rscript/renv command failed; carries the combined output."""


@dataclass
class BuildResult:
    ok: bool
    log: str


def _spec_dir(project_uid: str) -> Path:
    return project_fs.env_spec_dir(project_uid, "r")


def _lock_path(project_uid: str) -> Path:
    return _spec_dir(project_uid) / "renv.lock"


def _library_dir(project_uid: str) -> Path:
    return project_fs.env_cache_dir(project_uid, "r")


def library_path(project_uid: str) -> Path:
    """The env's private R library root (what R_LIBS points at for this project)."""
    return _library_dir(project_uid)


def is_built(project_uid: str) -> bool:
    lib = _library_dir(project_uid)
    return lib.exists() and any(lib.iterdir())


def _renv_env(project_uid: str) -> dict[str, str]:
    import os

    return {
        **os.environ,
        # Shared, instance-wide renv cache (one copy of each package for all projects).
        "RENV_PATHS_CACHE": str(project_fs.env_package_cache("renv")),
        # The project's private library — the build target.
        "RENV_PATHS_LIBRARY": str(_library_dir(project_uid)),
        "RENV_CONFIG_REPOS_OVERRIDE": settings.r_repos,
        # Never prompt in a headless subprocess.
        "RENV_CONFIG_AUTO_SNAPSHOT": "FALSE",
    }


def _run_r(project_uid: str, r_code: str) -> str:
    proc = __import__("subprocess").run(
        [settings.rscript_bin, "--vanilla", "-e", r_code],
        cwd=str(_spec_dir(project_uid)),
        env=_renv_env(project_uid),
        capture_output=True,
        text=True,
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        raise ProvisionError(out.strip() or "Rscript command failed")
    return out


def ensure_manifest(project_uid: str) -> Path:
    """Create an empty ``renv.lock`` if none exists so record/snapshot has a base.
    Idempotent."""
    lock = _lock_path(project_uid)
    if not lock.exists():
        lock.write_text(
            json.dumps(
                {
                    "R": {"Repositories": [{"Name": "CRAN", "URL": settings.r_repos}]},
                    "Packages": {},
                },
                indent=2,
            )
        )
    return lock


def list_packages(project_uid: str) -> list[dict]:
    """Recorded packages read from ``renv.lock`` (name + pinned version)."""
    lock = _lock_path(project_uid)
    if not lock.exists():
        return []
    data = json.loads(lock.read_text())
    packages = data.get("Packages", {}) or {}
    return [
        {"name": name, "spec": ("==" + p["Version"]) if p.get("Version") else ""}
        for name, p in sorted(packages.items())
    ]


def add_packages(project_uid: str, packages: list[str]) -> None:
    """Record packages into the lockfile (no library build yet). renv::record adds
    them to renv.lock; the actual install happens on build (renv::restore)."""
    ensure_manifest(project_uid)
    specs = ", ".join(f'"{_to_renv_ref(p)}"' for p in packages)
    _run_r(
        project_uid,
        f"renv::record(c({specs}), lockfile='renv.lock')",
    )


def remove_package(project_uid: str, package: str) -> None:
    ensure_manifest(project_uid)
    name = package.split("==")[0].split(">")[0].split("<")[0].strip()
    _run_r(
        project_uid,
        f"renv::record(list(), lockfile='renv.lock'); "
        f"lf <- renv::lockfile_read('renv.lock'); "
        f"lf$Packages[['{name}']] <- NULL; "
        f"renv::lockfile_write(lf, 'renv.lock')",
    )


def upgrade(project_uid: str, package: str | None = None) -> None:
    """Re-record newer versions into the lockfile: one package or all. Uses
    ``renv::record`` with the latest available version resolved from the repos."""
    ensure_manifest(project_uid)
    if package:
        _run_r(project_uid, f"renv::record('{package}', lockfile='renv.lock')")
    else:
        names = [p["name"] for p in list_packages(project_uid)]
        if names:
            specs = ", ".join(f'"{n}"' for n in names)
            _run_r(project_uid, f"renv::record(c({specs}), lockfile='renv.lock')")


def _to_renv_ref(requirement: str) -> str:
    """Turn a "pkg==1.2.3" requirement into a renv package ref ("pkg@1.2.3")."""
    if "==" in requirement:
        name, _, version = requirement.partition("==")
        return f"{name.strip()}@{version.strip()}"
    return requirement.strip()


async def build(project_uid: str, on_log=None) -> BuildResult:
    """Materialise the private library from ``renv.lock`` (``renv::restore``) as an
    async subprocess — off the event loop and killable on cancel."""
    ensure_manifest(project_uid)
    # Pass the target library explicitly: outside an activated renv project,
    # RENV_PATHS_LIBRARY isn't enough — renv restores into a default location.
    # Forward-slash the path so it's a valid R string literal on every OS.
    lib = str(_library_dir(project_uid)).replace("\\", "/")
    proc = await asyncio.create_subprocess_exec(
        settings.rscript_bin, "--vanilla", "-e",
        f"renv::restore(lockfile='renv.lock', library='{lib}', prompt=FALSE)",
        cwd=str(_spec_dir(project_uid)),
        env=_renv_env(project_uid),
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
    return BuildResult(ok=(code == 0), log="\n".join(lines))
