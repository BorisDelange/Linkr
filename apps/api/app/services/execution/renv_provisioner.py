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
import hashlib
import json
import os
import re
import shutil
import threading
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from app.config import settings
from app.services import project_fs
from app.services.execution import env_options
from app.services.execution.child_env import child_env
from app.services.execution.package_spec import package_name, validate_package_spec

# A hung `Rscript` (network black-hole resolving a package) must not pin a worker
# / build slot forever. Package-edit commands are quick metadata writes.
_R_EDIT_TIMEOUT = 120


_RENV_MISSING = re.compile(r"there is no package called .renv.")
RENV_MISSING_HINT = (
    "renv is not installed in this server's R and could not be installed from the configured "
    "CRAN repository (LINKR_R_REPOS); Linkr builds every project's R environment with it. "
    "Install it once for that R: Rscript -e 'install.packages(\"renv\")', or give Linkr a "
    "reachable CRAN mirror."
)
R_MISSING_HINT = (
    "R is not installed on this server (Rscript not found). Install R, or point "
    "LINKR_RSCRIPT_BIN at its Rscript."
)
# Set once renv loads; reset only by a test.
_renv_ready = False


class ProvisionError(Exception):
    """An Rscript/renv command failed; carries the combined output."""


def ensure_renv(on_log=None) -> None:
    """Make renv loadable by the provisioner: the server's R's own if it has one,
    else installed once into the Linkr-wide renv library (project_fs.renv_r_lib)
    from the configured repository — a mirror in an SPE. Raises ProvisionError
    saying what is missing when neither works."""
    global _renv_ready
    if _renv_ready:
        return
    import subprocess

    lib = str(project_fs.renv_r_lib()).replace("\\", "/")
    if (project_fs.renv_r_lib() / "renv" / "DESCRIPTION").exists():
        _renv_ready = True
        return
    repo = settings.r_repos.replace("'", "")
    code = (
        f"if (!nzchar(system.file(package='renv'))) {{ "
        f"message('Installing renv into {lib} from {repo}'); "
        f"install.packages('renv', lib='{lib}', repos='{repo}') }}; "
        f"quit(status = if (requireNamespace('renv', lib.loc=c('{lib}', .libPaths()), quietly=TRUE)) 0 else 3)"
    )
    try:
        proc = subprocess.run(
            [settings.rscript_bin, "--vanilla", "-e", code],
            capture_output=True, text=True, timeout=settings.build_timeout_seconds,
            env=child_env(provision=True),
        )
    except FileNotFoundError:
        raise ProvisionError(R_MISSING_HINT) from None
    except subprocess.TimeoutExpired:
        raise ProvisionError(f"Installing renv timed out.\n{RENV_MISSING_HINT}") from None
    out = ((proc.stdout or "") + (proc.stderr or "")).strip()
    if on_log is not None and out:
        on_log(out)
    if proc.returncode != 0:
        raise ProvisionError(f"{out}\n{RENV_MISSING_HINT}".strip())
    _renv_ready = True


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
    options = options or {}
    return {
        **child_env(provision=True),
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

    ensure_renv(on_log)
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
        if _RENV_MISSING.search(out):
            raise ProvisionError(f"{cmdline}\n{out.strip()}\n{RENV_MISSING_HINT}")
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
    loaded into memory FIRST, from Linkr's renv library or the system one, while both
    are still visible; its functions then keep working after .Library is swapped."""
    projlib = str(_library_dir(project_uid)).replace("\\", "/")
    sandbox = str(project_fs.r_sandbox()).replace("\\", "/")
    renv_lib = str(project_fs.renv_r_lib()).replace("\\", "/")
    return (
        f"suppressMessages(requireNamespace('renv', lib.loc=c('{renv_lib}', .libPaths()), quietly=TRUE)); "
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


# renv.lock record sources that resolve through the configured repositories, so
# RENV_CONFIG_REPOS_OVERRIDE puts them on the mirror. Every other source (GitHub,
# GitLab, Bitbucket, URL, git, Local, Bioconductor — whose repositories renv takes
# from its own Bioconductor settings, not the override) is fetched from where the
# record says.
_REPOSITORY_SOURCES = {"repository", "cran", "standard"}
_SOURCE_LABELS = {
    "github": "GitHub", "gitlab": "GitLab", "bitbucket": "Bitbucket", "bioconductor": "Bioconductor",
    "url": "a URL", "git": "a git repository", "local": "a local path",
}
_ARCHIVE_SUFFIXES = (".tar.gz", ".tgz", ".zip")
_MIRROR_ADVICE = "not from the deployment's package mirror"


# Repository names renv resolves from its own settings, not the override.
_OWN_REPOSITORIES = {"bioc", "bioconductor", "rforge", "r-forge"}
# What a restore under a mirror reads of a record: renv also fetches a record from
# a git URL or a local path it carries, whatever its Source says.
_RESTORED_FIELDS = ("Package", "Version", "Source", "Repository", "Hash", "Requirements")


def _record_origin_outside(record: dict, allowed: set[str]) -> str | None:
    source = str(record.get("Source") or record.get("RemoteType") or "").strip().lower()
    if source not in _REPOSITORY_SOURCES:
        return _SOURCE_LABELS.get(source, source or "an unknown source")
    repository = record.get("Repository")
    if isinstance(repository, str) and repository.strip().lower() in _OWN_REPOSITORIES:
        return repository
    for key in ("Repository", "RemoteRepos"):
        value = record.get(key)
        if isinstance(value, str) and "://" in value:
            parts = urlsplit(value)
            host = (parts.hostname or "").lower()
            if parts.scheme not in ("http", "https") or host not in allowed:
                return host or value
    return None


def _refuse_off_mirror(origins: dict[str, str]) -> None:
    if not origins:
        return
    which = "it" if len(origins) == 1 else "them"
    raise ProvisionError(
        "; ".join(f"package {name} comes from {origin}, {_MIRROR_ADVICE}" for name, origin in sorted(origins.items()))
        + f". Install {which} from the mirror or ask your administrator."
    )


def _require_mirror_sources(project_uid: str, options: dict | None, packages: list[str] = ()) -> None:
    """Under a deployment mirror, every package renv installs comes from the mirror:
    refuse a renv.lock record, or a requested package, that renv would fetch from
    anywhere else. Without a mirror, nothing is checked."""
    allowed = env_options.confined_hosts("r", options or {})
    if not allowed:
        return
    origins: dict[str, str] = {}
    lock = _lock_path(project_uid)
    if lock.exists():
        try:
            records = json.loads(lock.read_text()).get("Packages") or {}
        except (json.JSONDecodeError, OSError, AttributeError) as e:
            raise ProvisionError(f"renv.lock could not be read: {e}") from e
        for name, record in records.items():
            origin = _record_origin_outside(record if isinstance(record, dict) else {}, allowed)
            if origin:
                origins[str(name)] = origin
    # renv::install reads a name that is an archive or an existing path as a local
    # package rather than a repository one.
    for spec in packages:
        name = package_name(spec)
        if name.lower().endswith(_ARCHIVE_SUFFIXES) or (_spec_dir(project_uid) / name).exists():
            origins[name] = "a local file"
    _refuse_off_mirror(origins)


def _mirror_lockfile(project_uid: str) -> Path:
    """renv.lock reduced to the fields a repository install reads, for a restore
    under a mirror; `_require_mirror_sources` has accepted every record first."""
    data = json.loads(_lock_path(project_uid).read_text())
    packages = {
        str(name): {
            **{k: record[k] for k in _RESTORED_FIELDS if k in record},
            "Package": str(record.get("Package") or name),
            "Source": "Repository",
        }
        for name, record in (data.get("Packages") or {}).items()
        if isinstance(record, dict)
    }
    path = project_fs.cache_dir(project_uid) / "renv-mirror.lock"
    path.write_text(json.dumps({"R": data.get("R") or {}, "Packages": packages}, indent=2))
    return path


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
    # Validated (allowlist) before interpolation — the values reach `Rscript -e`
    # source, so an unescaped metachar would be R-code injection (RCE).
    safe = [validate_package_spec(p) for p in packages]
    _require_mirror_sources(project_uid, options, safe)
    ensure_r_sandbox(on_log=on_log)
    specs = ", ".join(f'"{_to_renv_ref(p)}"' for p in safe)
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
    if package:
        # Strip any version pin — upgrade means "go to latest".
        names = [validate_package_spec(package).split("==")[0].split(">")[0].split("<")[0].strip()]
    else:
        # Names read from renv.lock, which may come from a git repository, reach
        # `Rscript -e` source just the same.
        names = [validate_package_spec(p["name"]) for p in list_packages(project_uid)]
    _require_mirror_sources(project_uid, options, names)
    ensure_r_sandbox(on_log=on_log)
    projlib = str(_library_dir(project_uid)).replace("\\", "/")
    if not names:
        return
    targets = f'"{names[0]}"' if package else "c(" + ", ".join(f'"{n}"' for n in names) + ")"
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


def kernel_r_lib_ready() -> bool:
    lib = project_fs.kernel_r_lib()
    return all((lib / d / "DESCRIPTION").is_file() for d in _KERNEL_DEPS)


def shared_r_ready() -> bool:
    """Whether the shared R pieces an R session waits for (the sandbox, the kernel
    library, the `linkr` client package) are all in place. File checks only: it tells
    a first preparation, shown as a job, from the usual no-op. The client's own
    dependencies are not among them (client_r_deps_ready)."""
    source = client_r_source()
    client_ready = source is None or (
        _installed_client_fingerprint(project_fs.kernel_r_lib()) == _client_source_fingerprint(source)
    )
    return any(project_fs.r_sandbox().iterdir()) and kernel_r_lib_ready() and client_ready


_installs: set = set()


def _install_streamed(argv: list[str], lib: Path, on_log=None) -> tuple[int, str]:
    """Run a shared-library install, its output reaching ``on_log`` as it comes: an R
    that builds packages from source (Homebrew's, most Linux distributions') compiles
    for minutes on the first run, and a silent wait reads as a hang. Bounded by the
    build timeout, not the package-edit one. Returns (exit code, output)."""
    import subprocess

    # A server stopped mid-install leaves R's lock directory behind, and every later
    # install into `lib` then refuses to start. One install at a time goes into each
    # of these libraries, so a lock found here is stale.
    for lock in lib.glob("00LOCK*"):
        shutil.rmtree(lock, ignore_errors=True)
    try:
        proc = subprocess.Popen(
            argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace",
            env=child_env(provision=True),
        )
    except OSError as e:
        return 127, str(e)
    timed_out = threading.Event()

    def stop() -> None:
        timed_out.set()
        proc.kill()

    timer = threading.Timer(settings.build_timeout_seconds, stop)
    timer.daemon = True
    timer.start()
    _installs.add(proc)
    lines: list[str] = []
    try:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.rstrip()
            lines.append(line)
            if on_log is not None:
                on_log(line)
        code = proc.wait()
    finally:
        timer.cancel()
        _installs.discard(proc)
    if timed_out.is_set():
        lines.append(f"Timed out after {settings.build_timeout_seconds}s")
    return code, "\n".join(lines)


def stop_installs() -> None:
    """Kill the shared-library installs under way: their job was stopped."""
    for proc in list(_installs):
        proc.kill()


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
            env=child_env(provision=True),
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
            env=child_env(provision=True),
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
            env=child_env(provision=True),
        )
    except (subprocess.SubprocessError, OSError) as e:
        if on_log is not None:
            on_log(f"R sandbox ensure failed: {e}")


def ensure_kernel_r_lib(on_log=None) -> None:
    """Install the kernel's infra packages AND their full dependency closure into the
    shared kernel R library if any are missing. Idempotent and cheap once populated (a
    pure existence check). Called before an isolated R kernel starts so it can load
    jsonlite/base64enc/svglite from a library that holds ONLY the infra — never the site
    library where a global package (plotly, …) would leak in.

    The install runs inside the SAME isolation the kernel uses (``.Library`` swapped to
    the base-only sandbox, ``.libPaths()`` pinned to the kernel library), so the
    dependency resolver sees exactly what the kernel will see at load time and installs
    the whole closure. Otherwise ``install.packages`` finds svglite's deps (rlang, cli,
    systemfonts, …) already present in the site library and skips them — but the kernel
    can't reach those, so svglite silently fails to load: no figures, no error. On
    macOS's R.framework, base and contributed packages share one directory, so pinning
    ``R_LIBS`` is NOT enough — ``.Library`` itself must be swapped. Verified: without
    this, ``requireNamespace('svglite')`` is FALSE inside the isolated kernel with
    "there is no package called 'rlang'". Requires ensure_r_sandbox() first."""
    if kernel_r_lib_ready():
        return
    lib = str(project_fs.kernel_r_lib()).replace("\\", "/")
    sandbox = str(project_fs.r_sandbox()).replace("\\", "/")
    deps = ", ".join(f"'{d}'" for d in _KERNEL_DEPS)
    repo = settings.r_repos.replace("'", "")
    code = (
        f"local({{ .sb <- '{sandbox}'; "
        f"if (dir.exists(.sb)) {{ .b <- .BaseNamespaceEnv; "
        f"if (bindingIsLocked('.Library', .b)) unlockBinding('.Library', .b); "
        f"assign('.Library', .sb, envir = .b); lockBinding('.Library', .b) }}; "
        f".libPaths('{lib}') }}); "
        f"local({{ .need <- Filter(function(p) "
        f"!nzchar(system.file(package=p, lib.loc='{lib}')), c({deps})); "
        f"if (length(.need)) install.packages(.need, lib='{lib}', repos='{repo}', "
        f"dependencies=c('Depends','Imports','LinkingTo')) }})"
    )
    if on_log is not None:
        on_log(f"Installing the R packages every R session of Linkr runs on ({', '.join(_KERNEL_DEPS)}), once for this server.")
    code_, out = _install_streamed([settings.rscript_bin, "--vanilla", "-e", code], project_fs.kernel_r_lib(), on_log)
    # Best-effort: a failure surfaces as the kernel's own import error, clearer than
    # blocking the launch. But never silently: a half-populated library reads to the
    # user as "figures just don't work" with nothing in any log.
    if code_ != 0 and on_log is not None:
        on_log(f"kernel R lib ensure failed (exit {code_}): {out[-2000:]}")


# The `linkr` client package's own dependencies. They go in a SEPARATE library that is
# never on .libPaths() (see project_fs.client_r_lib): anything reachable from the kernel's
# path is loadable by user code, and a script that can library(duckdb) without declaring
# it breaks wherever the project's own environment is all there is.
_CLIENT_DEPS = ("DBI", "duckdb", "jsonlite")


def client_r_deps_ready() -> bool:
    lib = project_fs.client_r_lib()
    return all((lib / d / "DESCRIPTION").is_file() for d in _CLIENT_DEPS)


def _r_bin() -> str:
    """The ``R`` binary next to the configured ``Rscript`` — ``R CMD INSTALL`` must run
    the same R the kernels do. Falls back to a bare "R" on PATH when rscript_bin is not
    an absolute path (the default, "Rscript")."""
    rscript = Path(settings.rscript_bin)
    sibling = rscript.with_name("R")
    return str(sibling) if rscript.is_absolute() and sibling.exists() else "R"


def client_r_source() -> Path | None:
    """The `linkr` R client package sources shipped with the server, or None when they
    are not on disk (an install that dropped `packages/`)."""
    override = os.environ.get("LINKR_CLIENT_R_SOURCE")
    if override:
        path = Path(override)
        return path if (path / "DESCRIPTION").is_file() else None
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "packages" / "linkr-r"
        if (candidate / "DESCRIPTION").is_file():
            return candidate
    return None


def _client_source_fingerprint(source: Path) -> str:
    """Identity of the shipped client sources: the declared version plus the mtime and
    size of DESCRIPTION and every R file. Editing a function without bumping the version
    still changes this, which is the point — a stale client is invisible until a script
    calls something that moved."""
    parts = [(source / "DESCRIPTION").read_text(errors="ignore").strip()]
    for path in sorted((source / "R").glob("*.R")):
        stat = path.stat()
        parts.append(f"{path.name}:{stat.st_mtime_ns}:{stat.st_size}")
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def _installed_client_fingerprint(lib: Path) -> str | None:
    stamp = lib / "linkr" / "linkr-source-fingerprint"
    if not stamp.is_file():
        return None
    return stamp.read_text(errors="ignore").strip() or None


def ensure_client_r_deps(on_log=None) -> None:
    """Install the `linkr` client package's dependencies (DBI, duckdb, jsonlite) into
    the client library, kept off ``.libPaths()``: there they would let a script
    ``library(duckdb)`` without declaring it, and that script then breaks wherever the
    project's environment is all there is. The package reaches them through
    ``loadNamespace(lib.loc=)`` instead (the client's R/zzz.R), driven by
    ``LINKR_CLIENT_R_LIB``.

    Only `linkr_connect()` and the API helpers need them, so no session waits for this:
    the kernel manager runs it as a background job. An R that builds from source
    (Homebrew's) compiles duckdb for 10 to 30 minutes; the Docker image ships them
    built (``LINKR_CLIENT_R_LIB``). Raises ProvisionError when the install fails."""
    client_lib = str(project_fs.client_r_lib()).replace("\\", "/")
    sandbox = str(project_fs.r_sandbox()).replace("\\", "/")
    kernel_lib = str(project_fs.kernel_r_lib()).replace("\\", "/")
    deps = ", ".join(f"'{d}'" for d in _CLIENT_DEPS)
    repo = settings.r_repos.replace("'", "")
    # Same isolation the kernel runs under, for the same reason as ensure_kernel_r_lib:
    # the resolver must see what the kernel sees, or it skips deps that are only present
    # in the site library and the install is silently incomplete.
    code = (
        f"local({{ .sb <- '{sandbox}'; "
        f"if (dir.exists(.sb)) {{ .b <- .BaseNamespaceEnv; "
        f"if (bindingIsLocked('.Library', .b)) unlockBinding('.Library', .b); "
        f"assign('.Library', .sb, envir = .b); lockBinding('.Library', .b) }}; "
        f".libPaths(c('{client_lib}', '{kernel_lib}')) }}); "
        f"local({{ .need <- Filter(function(p) "
        f"!nzchar(system.file(package=p, lib.loc='{client_lib}')), c({deps})); "
        f"if (length(.need)) install.packages(.need, lib='{client_lib}', repos='{repo}', "
        f"dependencies=c('Depends','Imports','LinkingTo')) }})"
    )
    if on_log is not None:
        on_log(
            f"Installing the R packages library(linkr) opens databases with ({', '.join(_CLIENT_DEPS)}), once "
            "for this server. R sessions do not wait for it. An R that builds packages from source "
            "compiles duckdb: allow 10 to 30 minutes."
        )
    code_, out = _install_streamed([settings.rscript_bin, "--vanilla", "-e", code], project_fs.client_r_lib(), on_log)
    if code_ != 0 or not client_r_deps_ready():
        raise ProvisionError(f"The R packages of library(linkr) could not be installed (exit {code_}).\n{out[-2000:]}")


def ensure_client_r_package(on_log=None) -> None:
    """Install the `linkr` client package into the shared KERNEL library: it is the one
    library on every isolated kernel's ``.libPaths()``, so ``library(linkr)`` resolves
    even in a project whose environment has never been built — which is the promise the
    IDE docs make. Its dependencies come separately (ensure_client_r_deps).

    Reinstalled whenever the shipped SOURCES change, not just the declared version: the
    version is hand-edited and easy to forget, and a stale client is invisible until a
    script calls a function that moved. The fingerprint (mtime + size of every R file
    and DESCRIPTION) is stamped beside the install; a mismatch reinstalls. Idempotent
    and cheap otherwise (a few stat calls).
    """
    import subprocess

    source = client_r_source()
    if source is None:
        if on_log is not None:
            on_log("client R package sources not found; library(linkr) will not resolve")
        return

    kernel_lib = project_fs.kernel_r_lib()
    want = _client_source_fingerprint(source)
    if _installed_client_fingerprint(kernel_lib) == want:
        return
    try:
        # INSTALL, not install.packages(): the sources are a local directory, and this
        # skips the repo entirely. --no-test-load because the load test would resolve
        # the Suggests (DBI/duckdb) that deliberately are not on this library's path.
        res = subprocess.run(
            [
                _r_bin(), "CMD", "INSTALL",
                "--no-test-load", f"--library={kernel_lib}", str(source),
            ],
            capture_output=True, text=True, timeout=_R_EDIT_TIMEOUT,
            env=child_env(provision=True),
        )
    except (subprocess.SubprocessError, OSError) as e:
        # Best-effort, like the kernel library: a failure here surfaces to the user as
        # "could not find function linkr_scripts_dir", which is clearer than refusing to
        # start the kernel at all.
        if on_log is not None:
            on_log(f"client R lib ensure failed: {e}")
        return
    if res.returncode != 0:
        if on_log is not None:
            on_log(f"client R lib ensure failed (exit {res.returncode}): {res.stderr.strip()[:2000]}")
        return
    # Stamp only on success, so a failed install is retried next time rather than
    # recorded as up to date.
    (kernel_lib / "linkr" / "linkr-source-fingerprint").write_text(want, encoding="utf-8")


async def build(project_uid: str, on_log=None, options: dict | None = None) -> BuildResult:
    """Materialise the private library from ``renv.lock`` (``renv::restore``) — the
    full tree the lockfile pins (declared packages + their dependencies) — as an async
    subprocess, off the event loop and killable on cancel. Runs inside the kernel's
    isolation so restore resolves against the project lib + base R, not the global
    contributed packages."""
    ensure_manifest(project_uid)
    try:
        _require_mirror_sources(project_uid, options)
    except ProvisionError as e:
        if on_log is not None:
            on_log(str(e))
        return BuildResult(ok=False, log=str(e))
    ensure_r_sandbox(on_log=on_log)
    try:
        await asyncio.to_thread(ensure_renv, on_log)
    except ProvisionError as e:
        if on_log is not None:
            on_log(str(e))
        return BuildResult(ok=False, log=str(e))
    # Pass the target library explicitly: outside an activated renv project,
    # RENV_PATHS_LIBRARY isn't enough — renv restores into a default location.
    # Forward-slash the path so it's a valid R string literal on every OS.
    lib = str(_library_dir(project_uid)).replace("\\", "/")
    lockfile = "renv.lock"
    if env_options.confined_hosts("r", options or {}):
        lockfile = str(_mirror_lockfile(project_uid)).replace("\\", "/")
    restore_code = (
        _method_prefix(options)
        + _isolation_prefix(project_uid)
        + f"renv::restore(lockfile='{lockfile}', library='{lib}', prompt=FALSE)"
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
