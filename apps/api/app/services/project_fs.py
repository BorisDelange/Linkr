"""Per-project working directory on disk (RStudio/Jupyter model).

The disk is the single source of truth for the IDE's ``scripts/`` tree and for
``datasets/``. There is no DB table mirroring these files: the tree is derived by
scanning the real filesystem, so a file dropped in by any means (terminal, git,
another tool) shows up in the IDE. The kernel runs with the project directory as
its working directory, reaching files by their readable relative paths:

    data_dir/projects/<project_uid>/
      ├─ scripts/    IDE files (real names)
      └─ datasets/   dataset copies (real names)

Node ids are derived deterministically from the relative path (stable while the
file keeps its path). Paths from the API are validated to stay inside the subtree
(no ``..`` escape, no absolute paths).
"""

import hashlib
from pathlib import Path

from app.config import settings

# Files/dirs ignored when scanning (editor/OS noise, hidden caches).
_IGNORE = {".DS_Store", ".git", ".cache", "__pycache__", ".ipynb_checkpoints"}

_LANG_BY_EXT = {
    ".py": "python",
    ".r": "r",
    ".sql": "sql",
    ".ipynb": "python",
    ".rmd": "r",
    ".qmd": "r",
    ".md": "markdown",
    ".json": "json",
    ".txt": "text",
    ".csv": "csv",
    ".parquet": "parquet",
}


def project_dir(project_uid: str) -> Path:
    """Absolute path of the project's working directory (created on access)."""
    d = settings.data_path / "projects" / project_uid
    d.mkdir(parents=True, exist_ok=True)
    return d


# --- path bindings --------------------------------------------------------
# A project has three independent, re-bindable server dirs (Project.ide_path /
# scripts_path / datasets_path), each with a distinct role and its own default:
#   - ide_path      → the working dir the IDE shows and the terminal/kernel start
#                     in (default projects/<uid>). Can be broad (a whole home).
#   - scripts_path  → the code sub-tree packaged as scripts/ on export (default
#                     projects/<uid>/scripts). Chosen separately so an export never
#                     drags in datasets living elsewhere under a broad ide_path.
#   - datasets_path → where datasets live (default projects/<uid>/datasets).
# All machine-local (never exported): the async layer loads them from the DB and
# primes this cache; sync callers here (kernel cwd, file scans, export) read it
# without touching the DB. None in a slot = that dir's default.
_BINDINGS: dict[str, tuple[str | None, str | None, str | None]] = {}


def prime_binding(
    project_uid: str,
    ide_path: str | None,
    scripts_path: str | None,
    datasets_path: str | None,
) -> None:
    """Record a project's resolved path bindings for the sync scan/dir helpers.
    Called by the async layer (routes/services) after loading the Project row."""
    _BINDINGS[project_uid] = (ide_path or None, scripts_path or None, datasets_path or None)


def invalidate_binding(project_uid: str) -> None:
    _BINDINGS.pop(project_uid, None)


async def ensure_binding(db, project_uid: str) -> None:
    """Load the project's path bindings from the DB and cache them, so the sync
    scan/dir helpers resolve to the right server dirs. Idempotent per request; call
    from the async entry points (routes/services) before any project_fs scan. A
    missing project caches the defaults (all None)."""
    if project_uid in _BINDINGS:
        return
    from app.models.project import Project

    project = await db.get(Project, project_uid)
    prime_binding(
        project_uid,
        getattr(project, "ide_path", None) if project else None,
        getattr(project, "scripts_path", None) if project else None,
        getattr(project, "datasets_path", None) if project else None,
    )


def ide_binding(project_uid: str) -> str | None:
    return _BINDINGS.get(project_uid, (None, None, None))[0]


def scripts_binding(project_uid: str) -> str | None:
    return _BINDINGS.get(project_uid, (None, None, None))[1]


def datasets_binding(project_uid: str) -> str | None:
    return _BINDINGS.get(project_uid, (None, None, None))[2]


def ide_dir(project_uid: str) -> Path:
    """The IDE working dir the IDE tree shows and the terminal/kernel start in: the
    bound ide_path, else projects/<uid>/scripts. The default equals the default
    scripts_dir so out of the box the IDE shows exactly the code that gets exported;
    binding ide_path to a broader folder (a home containing code + data) is opt-in."""
    bound = ide_binding(project_uid)
    d = Path(bound) if bound else project_dir(project_uid) / "scripts"
    d.mkdir(parents=True, exist_ok=True)
    return d


def scripts_dir(project_uid: str) -> Path:
    """The code sub-tree packaged as scripts/ on export: the bound scripts_path,
    else projects/<uid>/scripts. NOT the IDE working dir (that is ide_dir)."""
    bound = scripts_binding(project_uid)
    d = Path(bound) if bound else project_dir(project_uid) / "scripts"
    d.mkdir(parents=True, exist_ok=True)
    return d


def datasets_dir(project_uid: str) -> Path:
    """The datasets directory: the bound datasets_path, else projects/<uid>/datasets."""
    bound = datasets_binding(project_uid)
    d = Path(bound) if bound else project_dir(project_uid) / "datasets"
    d.mkdir(parents=True, exist_ok=True)
    return d


def cache_dir(project_uid: str) -> Path:
    """Hidden per-project cache (never shown in the IDE tree; see _IGNORE)."""
    d = project_dir(project_uid) / ".cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def env_spec_dir(project_uid: str, language: str) -> Path:
    """The committed declarative spec of a managed environment
    (``environments/<language>/`` — manifest + lockfile). Versioned in the project
    git and exported. Lives under the project dir, NOT the (re-bindable) scripts
    dir, so it travels with the project regardless of the IDE binding."""
    d = project_dir(project_uid) / "environments" / language
    d.mkdir(parents=True, exist_ok=True)
    return d


def env_cache_dir(project_uid: str, language: str) -> Path:
    """The materialised venv / renv library of a managed environment — machine-local,
    git-ignored (under .cache, which is in _IGNORE), rebuilt from the spec. Made of
    links into the Linkr-wide package cache (env_package_cache)."""
    d = cache_dir(project_uid) / "envs" / language
    d.mkdir(parents=True, exist_ok=True)
    return d


def env_package_cache(tool: str) -> Path:
    """The Linkr-wide shared package cache for a tool (``uv`` / ``renv``): one copy
    of each (package, version) for ALL projects, so a version installed for one
    project is reused by the next. Under data_dir/.cache/<tool>."""
    d = settings.data_path / ".cache" / tool
    d.mkdir(parents=True, exist_ok=True)
    return d


def r_sandbox() -> Path:
    """A Linkr-wide R "sandbox": a directory of symlinks to ONLY the base+recommended
    packages of the system R (mirroring renv's sandbox). An isolated R kernel replaces
    .Library with this so base tooling resolves while contributed packages sharing the
    system library directory (the macOS R.framework case) stay hidden. One per
    instance, under data_dir/.cache/r-sandbox."""
    d = settings.data_path / ".cache" / "r-sandbox"
    d.mkdir(parents=True, exist_ok=True)
    return d


def kernel_r_script(source: str) -> Path:
    """The R kernel loop, materialised as a file so it can be run as
    ``Rscript <file>`` instead of ``Rscript -e <source>``.

    ``-e`` silently truncates a long program (around 10k characters, emitting only
    a mangled WARNING on stdout), and the loop had grown close enough to that
    limit that adding a few lines made the kernel hang at boot with no usable
    error. A file has no such limit. Rewritten whenever the source changes so a
    deploy never runs a stale loop. Under data_dir/.cache/kernel-r.
    """
    d = settings.data_path / ".cache" / "kernel-r"
    d.mkdir(parents=True, exist_ok=True)
    path = d / "kernel_loop.R"
    if not path.exists() or path.read_text(encoding="utf-8") != source:
        # Write-then-rename: a kernel spawning concurrently never sees a half file.
        digest = hashlib.sha256(source.encode("utf-8")).hexdigest()[:12]
        tmp = d / f"kernel_loop.{digest}.tmp"
        tmp.write_text(source, encoding="utf-8")
        tmp.replace(path)
    return path


def kernel_r_lib() -> Path:
    """A Linkr-wide R library holding ONLY the kernel's own infra packages
    (jsonlite/base64enc/svglite — the host↔kernel protocol + figure capture). It is
    put on every isolated R kernel's .libPaths() so the kernel works even for an
    empty/unbuilt project env, WITHOUT re-exposing the site library (which is where a
    global package like plotly would otherwise leak in). One shared install for all
    projects. Under data_dir/.cache/kernel-r-lib."""
    d = settings.data_path / ".cache" / "kernel-r-lib"
    d.mkdir(parents=True, exist_ok=True)
    return d


def client_r_lib() -> Path:
    """A Linkr-wide R library holding the ``linkr`` client package and ITS
    dependencies (DBI, duckdb, jsonlite).

    Separate from kernel_r_lib on purpose. That library sits on every isolated
    kernel's .libPaths(), so anything in it is loadable by user code — putting DBI
    and duckdb there would let a script ``library(duckdb)`` without declaring it,
    and the script would then break on a machine where the project's own
    environment is all there is. This library is NOT on .libPaths(); the linkr
    package appends it for its own namespace resolution only. So
    ``library(linkr)`` works in an empty project, while ``library(duckdb)``
    remains something the project must declare — which is what makes an exported
    project reproducible."""
    d = settings.data_path / ".cache" / "client-r-lib"
    d.mkdir(parents=True, exist_ok=True)
    return d


def dataset_path(project_uid: str, rel: str) -> Path:
    """Absolute on-disk path of a raw dataset file, validated against traversal."""
    return _safe_join(datasets_dir(project_uid), rel)


def runtime_env(project_uid: str, token: str | None = None) -> dict[str, str]:
    """The LINKR_* variables injected into every kernel/terminal so scripts reach
    the project's dirs by name rather than a hard-coded absolute path (a binding can
    be re-pointed without editing code). Bindings must be primed first.

    `token` is a kernel token (``create_kernel_token``) for the R/Python client
    libraries, which call the API to list and open the project's databases. It is
    omitted for runs with no acting user (an internal render), where the libraries'
    path helpers still work and only ``linkr_databases()`` is unavailable."""
    env = {
        "LINKR_IDE": str(ide_dir(project_uid)),
        "LINKR_SCRIPTS": str(scripts_dir(project_uid)),
        "LINKR_DATASETS": str(datasets_dir(project_uid)),
        "LINKR_PROJECT": str(project_dir(project_uid)),
        "LINKR_PROJECT_UID": project_uid,
    }
    if token:
        env["LINKR_API_URL"] = settings.kernel_api_url
        env["LINKR_TOKEN"] = token
        # The client libraries ATTACH Postgres/MySQL from the script's own process,
        # which needs the matching DuckDB extension. Pointing them at the server's
        # extension directory reuses the copy the app already downloaded — so a
        # connection works on an air-gapped instance, and does not re-download per
        # session (DuckDB's default is a temp dir that dies with the process).
        env["LINKR_DUCKDB_EXTENSIONS"] = str(_duckdb_ext_dir())
    return env


def _duckdb_ext_dir() -> Path:
    """The DuckDB extension directory the server itself installs into (mirrors
    db_connect/managed_db, which own the same path)."""
    d = settings.data_path / "_duckdb_ext"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _safe_join(root: Path, rel: str) -> Path:
    """Resolve ``rel`` under ``root``, rejecting traversal outside the subtree."""
    root = root.resolve()
    target = (root / rel).resolve()
    if root != target and root not in target.parents:
        raise ValueError(f"Path escapes project directory: {rel}")
    return target


def node_id(prefix: str, rel: str) -> str:
    """Deterministic id from a relative path (stable while the path is stable)."""
    h = hashlib.sha1(rel.encode("utf-8")).hexdigest()[:16]
    return f"{prefix}-{h}"


def language_for(name: str) -> str | None:
    return _LANG_BY_EXT.get(Path(name).suffix.lower())


# --- IDE working dir ------------------------------------------------------
# The IDE reads/writes files in ide_dir (the working dir), which may be broader
# than the exported scripts_dir. Historically these functions kept the "script"
# name; they operate on ide_dir.

def script_path(project_uid: str, rel: str) -> Path:
    return _safe_join(ide_dir(project_uid), rel)


def scan_scripts(project_uid: str) -> list[dict]:
    """Walk the IDE working dir and return its tree with real files/folders as the
    top-level nodes (no synthetic root: the working dir IS the root, matching what
    a terminal opened in it sees). Node fields: id, name, type, parentId, path,
    language, order. Content is read separately (read_script)."""
    root = ide_dir(project_uid)
    return _scan_tree(root, "ide", parent_id=None)


def scan_scripts_for_export(project_uid: str) -> list[dict]:
    """Walk the CODE dir (scripts_dir) — the sub-tree packaged as scripts/ on
    export. Distinct from scan_scripts (the whole IDE working dir): only the code
    is versioned/exported, so a broad ide_path never drags datasets into scripts/."""
    root = scripts_dir(project_uid)
    return _scan_tree(root, "ide", parent_id=None)


def export_script_path(project_uid: str, rel: str) -> Path:
    """Absolute path of a code file under scripts_dir (used to read content during
    export, since read_script targets the IDE working dir)."""
    return _safe_join(scripts_dir(project_uid), rel)


def read_script(project_uid: str, rel: str) -> str:
    # A bound ide_path can hold binary files (xlsx, docx, parquet…). The IDE only
    # edits text, so a non-decodable file reads as empty rather than 500-ing the
    # whole tree scan (list_files reads every file's content in one pass).
    p = script_path(project_uid, rel)
    if not p.is_file():
        return ""
    try:
        return p.read_text(encoding="utf-8")
    except (UnicodeDecodeError, ValueError):
        return ""


def write_script(project_uid: str, rel: str, content: str) -> None:
    p = script_path(project_uid, rel)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


def make_folder(project_uid: str, rel: str) -> None:
    script_path(project_uid, rel).mkdir(parents=True, exist_ok=True)


def delete_script(project_uid: str, rel: str) -> None:
    """Remove a script file or folder subtree; ignore if already gone."""
    import shutil

    p = script_path(project_uid, rel)
    if p.is_dir():
        shutil.rmtree(p, ignore_errors=True)
    elif p.is_file():
        p.unlink(missing_ok=True)


def move_script(project_uid: str, old_rel: str, new_rel: str) -> None:
    """Move/rename a script file or folder within the scripts tree."""
    src = script_path(project_uid, old_rel)
    dst = script_path(project_uid, new_rel)
    if not src.exists():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.replace(dst)


# --- datasets/ ------------------------------------------------------------

def scan_datasets(project_uid: str) -> list[dict]:
    """Walk datasets/ and return the flat node shape (no synthetic root here;
    the datasets panel is its own container)."""
    root = datasets_dir(project_uid)
    return _scan_tree(root, "ds", parent_id=None)



# --- shared scan ----------------------------------------------------------

def _scan_tree(root: Path, prefix: str, parent_id: str | None) -> list[dict]:
    """Depth-first walk of `root`; returns a flat list of node dicts with
    parent-pointer hierarchy. Ids/parentIds derive from the relative path.
    Top-level entries get `parent_id` as their parent (a synthetic root, or None)."""
    nodes: list[dict] = []

    def walk(dir_path: Path, current_parent: str | None) -> None:
        try:
            entries = sorted(
                (e for e in dir_path.iterdir() if e.name not in _IGNORE),
                key=lambda e: (e.is_file(), e.name.lower()),
            )
        except FileNotFoundError:
            return
        for i, entry in enumerate(entries):
            rel = entry.relative_to(root).as_posix()
            nid = node_id(prefix, rel)
            is_dir = entry.is_dir()
            nodes.append({
                "id": nid,
                "name": entry.name,
                "type": "folder" if is_dir else "file",
                "parentId": current_parent,
                "path": rel,
                "language": None if is_dir else language_for(entry.name),
                "order": i,
            })
            if is_dir:
                walk(entry, nid)

    walk(root, parent_id)
    return nodes
