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
from app.services.execution.package_spec import validate_package_spec

# A hung `Rscript` (network black-hole resolving a package) must not pin a worker
# / build slot forever. Package-edit commands are quick metadata writes.
_R_EDIT_TIMEOUT = 120


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


def _renv_env(project_uid: str, options: dict | None = None) -> dict[str, str]:
    import os

    options = options or {}
    return {
        **os.environ,
        # Shared, instance-wide renv cache (one copy of each package for all projects).
        "RENV_PATHS_CACHE": str(project_fs.env_package_cache("renv")),
        # The project's private library — the build target.
        "RENV_PATHS_LIBRARY": str(_library_dir(project_uid)),
        "RENV_CONFIG_REPOS_OVERRIDE": options.get("repos") or settings.r_repos,
        # Never prompt in a headless subprocess.
        "RENV_CONFIG_AUTO_SNAPSHOT": "FALSE",
    }


def _method_prefix(options: dict | None) -> str:
    """R code that sets the download method before the real command, when the env
    overrides it (e.g. method='curl' behind a corporate proxy). Validated upstream
    (env_options allowlist), but re-checked here as defence in depth before it
    reaches Rscript source."""
    method = (options or {}).get("method")
    if method and method in {"auto", "libcurl", "curl", "wget", "internal", "wininet"}:
        return f"options(download.file.method='{method}'); "
    return ""


def _run_r(project_uid: str, r_code: str, on_log=None, options: dict | None = None) -> str:
    import subprocess

    r_code = _method_prefix(options) + r_code
    env = _renv_env(project_uid, options)
    cmdline = f"$ {settings.rscript_bin} --vanilla -e {r_code!r}"
    if on_log is not None:
        on_log(cmdline)
    try:
        proc = subprocess.run(
            [settings.rscript_bin, "--vanilla", "-e", r_code],
            cwd=str(_spec_dir(project_uid)),
            env=env,
            capture_output=True,
            text=True,
            timeout=_R_EDIT_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        raise ProvisionError(f"{cmdline}\nRscript command timed out")
    out = (proc.stdout or "") + (proc.stderr or "")
    if on_log is not None and out.strip():
        on_log(out.rstrip())
    if proc.returncode != 0:
        raise ProvisionError(f"{cmdline}\n{out.strip()}" if out.strip() else f"{cmdline}\nRscript command failed")
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


def add_packages(project_uid: str, packages: list[str], on_log=None, options: dict | None = None) -> None:
    """Record packages into the lockfile (no library build yet). renv::record adds
    them to renv.lock; the actual install happens on build (renv::restore)."""
    ensure_manifest(project_uid)
    # Validated (allowlist) before interpolation — the values reach `Rscript -e`
    # source, so an unescaped metachar would be R-code injection (RCE).
    specs = ", ".join(f'"{_to_renv_ref(validate_package_spec(p))}"' for p in packages)
    _run_r(
        project_uid,
        f"renv::record(c({specs}), lockfile='renv.lock')",
        on_log=on_log,
        options=options,
    )


def remove_package(project_uid: str, package: str, on_log=None, options: dict | None = None) -> None:
    ensure_manifest(project_uid)
    name = validate_package_spec(package).split("==")[0].split(">")[0].split("<")[0].strip()
    _run_r(
        project_uid,
        f"renv::record(list(), lockfile='renv.lock'); "
        f"lf <- renv::lockfile_read('renv.lock'); "
        f"lf$Packages[['{name}']] <- NULL; "
        f"renv::lockfile_write(lf, 'renv.lock')",
        on_log=on_log,
        options=options,
    )


def upgrade(project_uid: str, package: str | None = None, on_log=None, options: dict | None = None) -> None:
    """Re-record newer versions into the lockfile: one package or all. Uses
    ``renv::record`` with the latest available version resolved from the repos."""
    ensure_manifest(project_uid)
    if package:
        safe = validate_package_spec(package)
        _run_r(project_uid, f"renv::record('{safe}', lockfile='renv.lock')", on_log=on_log, options=options)
    else:
        names = [p["name"] for p in list_packages(project_uid)]
        if names:
            specs = ", ".join(f'"{n}"' for n in names)
            _run_r(project_uid, f"renv::record(c({specs}), lockfile='renv.lock')", on_log=on_log, options=options)


def _to_renv_ref(requirement: str) -> str:
    """Turn a "pkg==1.2.3" requirement into a renv package ref ("pkg@1.2.3")."""
    if "==" in requirement:
        name, _, version = requirement.partition("==")
        return f"{name.strip()}@{version.strip()}"
    return requirement.strip()


async def build(project_uid: str, on_log=None, options: dict | None = None) -> BuildResult:
    """Materialise the private library from ``renv.lock`` (``renv::restore``) as an
    async subprocess — off the event loop and killable on cancel."""
    ensure_manifest(project_uid)
    # Pass the target library explicitly: outside an activated renv project,
    # RENV_PATHS_LIBRARY isn't enough — renv restores into a default location.
    # Forward-slash the path so it's a valid R string literal on every OS.
    lib = str(_library_dir(project_uid)).replace("\\", "/")
    restore_code = _method_prefix(options) + f"renv::restore(lockfile='renv.lock', library='{lib}', prompt=FALSE)"
    if on_log is not None:
        on_log(f"$ {settings.rscript_bin} --vanilla -e {restore_code!r}")
    proc = await asyncio.create_subprocess_exec(
        settings.rscript_bin, "--vanilla", "-e",
        restore_code,
        cwd=str(_spec_dir(project_uid)),
        env=_renv_env(project_uid, options),
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
    return BuildResult(ok=(code == 0), log="\n".join(lines))
