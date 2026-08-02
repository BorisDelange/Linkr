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


def _isolation_prefix(project_uid: str) -> str:
    """R code that puts a package op inside the SAME isolation the kernel uses (see
    kernel.py): replace .Library with the shared sandbox (base+recommended only) and
    pin .libPaths() to [project library]. So install.packages() resolves a dependency
    (e.g. plotly's ggplot2) against the project library + base R — never the server's
    global contributed packages — and installs whatever is missing INTO the project
    library. Requires the sandbox to be populated first (ensure_r_sandbox).

    renv itself is a contributed package (not in the base-only sandbox), so it is
    loaded into memory FIRST, while the system library is still visible; its functions
    then keep working after .Library is swapped."""
    projlib = str(_library_dir(project_uid)).replace("\\", "/")
    sandbox = str(project_fs.r_sandbox()).replace("\\", "/")
    return (
        "suppressMessages(requireNamespace('renv', quietly=TRUE)); "
        f"local({{ .sb <- '{sandbox}'; "
        f"if (dir.exists(.sb)) {{ .b <- .BaseNamespaceEnv; "
        f"if (bindingIsLocked('.Library', .b)) unlockBinding('.Library', .b); "
        f"assign('.Library', .sb, envir = .b); lockBinding('.Library', .b) }}; "
        f".libPaths('{projlib}') }}); "
    )


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


def check_updates(project_uid: str, options: dict | None = None) -> dict[str, str]:
    """Which installed packages have a newer version on the repo → {name: latest}.
    ONE batch query (old.packages compares the whole project library against the repo
    index), never per package. On-demand only — the caller caches the result; it never
    runs on modal open or install. Empty when nothing is outdated or the lib is empty."""
    projlib = str(_library_dir(project_uid)).replace("\\", "/")
    repo = ((options or {}).get("repos") or settings.r_repos).replace("'", "")
    # old.packages returns a matrix (Package, Installed, ReposVer, …) or NULL. We build
    # each "name":"version" pair with toJSON on a named list, then wrap in braces, so
    # the output is a JSON object of {outdated package: latest version}. Written as a
    # plain string (not an f-string) to avoid brace-escaping noise.
    code = (
        "suppressWarnings(local({ "
        "op <- old.packages(lib.loc='%s', repos='%s'); "
        "if (is.null(op)) { cat('{}') } else { "
        "v <- as.list(op[, 'ReposVer']); names(v) <- op[, 'Package']; "
        "cat(jsonlite::toJSON(v, auto_unbox=TRUE)) } }))"
    ) % (projlib, repo)
    out = _run_r(project_uid, code, options=options)
    # The last non-empty line is the JSON object (R may print warnings before it).
    for line in reversed(out.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                break
    return {}


def _snapshot_code(project_uid: str) -> str:
    """renv::snapshot of the project library into renv.lock, capturing the FULL tree
    actually installed (declared packages + their dependencies) so the lockfile is
    what gets versioned/exported and what a rebuild restores — truly reproducible.
    type='all' records every package present in the library, not just those reachable
    from project code (there is no package code to scan at this layer)."""
    projlib = str(_library_dir(project_uid)).replace("\\", "/")
    return (
        f"renv::snapshot(library='{projlib}', lockfile='renv.lock', "
        f"type='all', prompt=FALSE, force=TRUE)"
    )


def add_packages(project_uid: str, packages: list[str], on_log=None, options: dict | None = None) -> None:
    """Install package(s) — AND their missing dependencies — into the project library,
    then snapshot the full tree into renv.lock. Runs inside the kernel's isolation
    (sandbox as .Library) so a dependency resolves against the project lib + base R,
    never the server's global contributed packages. Only missing dependencies are
    installed; an already-present one is left at its version (renv default)."""
    ensure_manifest(project_uid)
    ensure_r_sandbox(on_log=on_log)
    # Validated (allowlist) before interpolation — the values reach `Rscript -e`
    # source, so an unescaped metachar would be R-code injection (RCE).
    specs = ", ".join(f'"{_to_renv_ref(validate_package_spec(p))}"' for p in packages)
    projlib = str(_library_dir(project_uid)).replace("\\", "/")
    _run_r(
        project_uid,
        _isolation_prefix(project_uid)
        + f"renv::install(c({specs}), library='{projlib}', prompt=FALSE); "
        + _snapshot_code(project_uid),
        on_log=on_log,
        options=options,
    )


def remove_package(project_uid: str, package: str, on_log=None, options: dict | None = None) -> None:
    """Uninstall a package from the project library, then re-snapshot so the lockfile
    reflects the removal. Its now-orphaned dependencies are left installed (renv does
    not garbage-collect them here) but a later snapshot with a clean library would
    drop them — we keep it simple and safe."""
    ensure_manifest(project_uid)
    name = validate_package_spec(package).split("==")[0].split(">")[0].split("<")[0].strip()
    projlib = str(_library_dir(project_uid)).replace("\\", "/")
    _run_r(
        project_uid,
        _isolation_prefix(project_uid)
        + f"try(remove.packages('{name}', lib='{projlib}'), silent=TRUE); "
        + _snapshot_code(project_uid),
        on_log=on_log,
        options=options,
    )


def upgrade(project_uid: str, package: str | None = None, on_log=None, options: dict | None = None) -> None:
    """Install the latest version of one package (or every installed one) into the
    project library, then snapshot. Like add_packages, runs isolated and re-locks the
    full tree so the lockfile stays the reproducible source of truth."""
    ensure_manifest(project_uid)
    ensure_r_sandbox(on_log=on_log)
    projlib = str(_library_dir(project_uid)).replace("\\", "/")
    if package:
        # Strip any version pin — upgrade means "go to latest".
        name = validate_package_spec(package).split("==")[0].split(">")[0].split("<")[0].strip()
        targets = f'"{name}"'
    else:
        names = [p["name"] for p in list_packages(project_uid)]
        if not names:
            return
        targets = "c(" + ", ".join(f'"{n}"' for n in names) + ")"
    _run_r(
        project_uid,
        _isolation_prefix(project_uid)
        + f"renv::install({targets}, library='{projlib}', prompt=FALSE, rebuild=FALSE); "
        + _snapshot_code(project_uid),
        on_log=on_log,
        options=options,
    )


def _to_renv_ref(requirement: str) -> str:
    """Turn a "pkg==1.2.3" requirement into a renv package ref ("pkg@1.2.3")."""
    if "==" in requirement:
        name, _, version = requirement.partition("==")
        return f"{name.strip()}@{version.strip()}"
    return requirement.strip()


# Infra packages the R kernel loop itself needs (host↔kernel JSON protocol +
# figure capture — see kernel.py _R_KERNEL_LOOP): jsonlite/base64enc are required,
# svglite optional (no figures without it). They are NOT user packages (never in
# renv.lock); they live in a shared kernel library (project_fs.kernel_r_lib) that
# every isolated R kernel puts on its .libPaths(), so the kernel works even for an
# empty/unbuilt env without re-exposing the site library.
_KERNEL_DEPS = ("jsonlite", "base64enc", "svglite")


def list_kernel_packages() -> list[dict]:
    """The kernel infra packages (jsonlite/base64enc/svglite) with the version
    installed in the shared kernel library. Project-independent — they live in one
    library every isolated R kernel shares. Marked ``system`` so the UI shows them
    (they make the kernel work) but forbids removing them. A dep not yet installed
    shows an empty version (it is materialised on first kernel launch)."""
    lib = project_fs.kernel_r_lib()
    out: list[dict] = []
    for name in _KERNEL_DEPS:
        desc = lib / name / "DESCRIPTION"
        version = ""
        if desc.exists():
            for line in desc.read_text(errors="ignore").splitlines():
                if line.startswith("Version:"):
                    version = line.split(":", 1)[1].strip()
                    break
        out.append({
            "name": name,
            "spec": ("==" + version) if version else "",
            "system": True,
        })
    return out


def check_kernel_updates(options: dict | None = None) -> dict[str, str]:
    """Outdated kernel infra packages → {name: latest}. One batch query against the
    shared kernel library, same shape as ``check_updates`` for user packages."""
    lib = str(project_fs.kernel_r_lib()).replace("\\", "/")
    repo = ((options or {}).get("repos") or settings.r_repos).replace("'", "")
    code = ("suppressWarnings(local({ op <- old.packages(lib.loc='%s', repos='%s'); "
            "if (is.null(op)) { cat('{}') } else { "
            "v <- as.list(op[, 'ReposVer']); names(v) <- op[, 'Package']; "
            "cat(jsonlite::toJSON(v, auto_unbox=TRUE)) } }))") % (lib, repo)
    import subprocess

    try:
        res = subprocess.run(
            [settings.rscript_bin, "--vanilla", "-e", code],
            capture_output=True, text=True, timeout=_R_EDIT_TIMEOUT,
        )
    except (subprocess.SubprocessError, OSError):
        return {}
    for line in reversed(res.stdout.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                break
            # Only the infra packages — the kernel lib holds nothing else, but guard.
            return {k: v for k, v in parsed.items() if k in _KERNEL_DEPS}
    return {}


def upgrade_kernel_package(package: str, on_log=None, options: dict | None = None) -> None:
    """Reinstall one kernel infra package to the latest version in the shared kernel
    library. No lockfile involved — the kernel lib is machine-local infra, not part of
    the project's versioned spec."""
    if package not in _KERNEL_DEPS:
        raise ProvisionError(f"'{package}' is not a kernel package")
    import subprocess

    lib = str(project_fs.kernel_r_lib()).replace("\\", "/")
    repo = ((options or {}).get("repos") or settings.r_repos).replace("'", "")
    code = f"install.packages('{package}', lib='{lib}', repos='{repo}')"
    try:
        res = subprocess.run(
            [settings.rscript_bin, "--vanilla", "-e", code],
            capture_output=True, text=True, timeout=_R_EDIT_TIMEOUT,
        )
    except (subprocess.SubprocessError, OSError) as e:
        raise ProvisionError(str(e)) from e
    if on_log is not None and res.stdout:
        on_log(res.stdout)
    if res.returncode != 0:
        raise ProvisionError(res.stderr or res.stdout or "install failed")


def ensure_r_sandbox(on_log=None) -> None:
    """Populate the shared R "sandbox" — a directory of symlinks to ONLY the base +
    recommended packages of the system R (selected by Priority, mirroring renv's
    sandbox). An isolated kernel replaces .Library with this sandbox, so base tooling
    (stats, methods, MASS, …) resolves while contributed packages in the same system
    directory (the macOS R.framework case) do NOT. Idempotent: skips packages already
    linked. Cheap once populated."""
    import subprocess

    sandbox = str(project_fs.r_sandbox()).replace("\\", "/")
    # installed.packages(priority=...) picks base+recommended by metadata, then symlink
    # each into the sandbox if not already present.
    code = (
        "local({ .sb <- '%s'; "
        "ip <- installed.packages(lib.loc = .Library, priority = c('base','recommended')); "
        "for (i in seq_len(nrow(ip))) { "
        "  pkg <- ip[i,'Package']; from <- file.path(ip[i,'LibPath'], pkg); to <- file.path(.sb, pkg); "
        "  if (!file.exists(to)) file.symlink(from, to) } })"
    ) % sandbox
    try:
        subprocess.run(
            [settings.rscript_bin, "--vanilla", "-e", code],
            capture_output=True, text=True, timeout=_R_EDIT_TIMEOUT,
        )
    except (subprocess.SubprocessError, OSError) as e:
        if on_log is not None:
            on_log(f"R sandbox ensure failed: {e}")


def ensure_kernel_r_lib(on_log=None) -> None:
    """Install the kernel's infra packages into the shared kernel R library if any
    are missing. Idempotent and cheap once populated (a pure existence check). Called
    before an isolated R kernel starts so it can load jsonlite/base64enc/svglite from
    a library that holds ONLY the infra — never the site library where a global
    package (plotly, …) would leak in."""
    import subprocess

    lib = str(project_fs.kernel_r_lib()).replace("\\", "/")
    deps = ", ".join(f"'{d}'" for d in _KERNEL_DEPS)
    repo = settings.r_repos.replace("'", "")
    code = (
        f"local({{ .need <- Filter(function(p) "
        f"!nzchar(system.file(package=p, lib.loc='{lib}')), c({deps})); "
        f"if (length(.need)) install.packages(.need, lib='{lib}', repos='{repo}') }})"
    )
    try:
        subprocess.run(
            [settings.rscript_bin, "--vanilla", "-e", code],
            capture_output=True, text=True, timeout=_R_EDIT_TIMEOUT,
        )
    except (subprocess.SubprocessError, OSError) as e:
        # Best-effort: a failure here surfaces as the kernel's own import error, which
        # is clearer than blocking the launch. Log for diagnostics.
        if on_log is not None:
            on_log(f"kernel R lib ensure failed: {e}")


async def build(project_uid: str, on_log=None, options: dict | None = None) -> BuildResult:
    """Materialise the private library from ``renv.lock`` (``renv::restore``) — the
    full tree the lockfile pins (declared packages + their dependencies) — as an async
    subprocess, off the event loop and killable on cancel. Runs inside the kernel's
    isolation so restore resolves against the project lib + base R, not the global
    contributed packages."""
    ensure_manifest(project_uid)
    ensure_r_sandbox(on_log=on_log)
    # Pass the target library explicitly: outside an activated renv project,
    # RENV_PATHS_LIBRARY isn't enough — renv restores into a default location.
    # Forward-slash the path so it's a valid R string literal on every OS.
    lib = str(_library_dir(project_uid)).replace("\\", "/")
    restore_code = (
        _method_prefix(options)
        + _isolation_prefix(project_uid)
        + f"renv::restore(lockfile='renv.lock', library='{lib}', prompt=FALSE)"
    )
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
