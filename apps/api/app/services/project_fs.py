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
# A project's IDE working dir and datasets/ can be re-bound to any server path
# (Project.ide_path / datasets_path). These are machine-local (never exported):
# the async layer loads them from the DB and primes this cache; sync callers here
# (kernel cwd, file scans) read it without touching the DB. None = the default
# projects/<uid>/scripts|datasets.
_BINDINGS: dict[str, tuple[str | None, str | None]] = {}


def prime_binding(
    project_uid: str, ide_path: str | None, datasets_path: str | None
) -> None:
    """Record a project's resolved path bindings for the sync scan/dir helpers.
    Called by the async layer (routes/services) after loading the Project row."""
    _BINDINGS[project_uid] = (ide_path or None, datasets_path or None)


def invalidate_binding(project_uid: str) -> None:
    _BINDINGS.pop(project_uid, None)


async def ensure_binding(db, project_uid: str) -> None:
    """Load the project's ide_path/datasets_path from the DB and cache them, so the
    sync scan/dir helpers resolve to the right server dirs. Idempotent per request;
    call from the async entry points (routes/services) before any project_fs scan.
    A missing project caches the defaults (both None)."""
    if project_uid in _BINDINGS:
        return
    from app.models.project import Project

    project = await db.get(Project, project_uid)
    prime_binding(
        project_uid,
        getattr(project, "ide_path", None) if project else None,
        getattr(project, "datasets_path", None) if project else None,
    )


def ide_binding(project_uid: str) -> str | None:
    return _BINDINGS.get(project_uid, (None, None))[0]


def datasets_binding(project_uid: str) -> str | None:
    return _BINDINGS.get(project_uid, (None, None))[1]


def scripts_dir(project_uid: str) -> Path:
    """The IDE working directory: the bound ide_path, else projects/<uid>/scripts."""
    bound = ide_binding(project_uid)
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


def dataset_path(project_uid: str, rel: str) -> Path:
    """Absolute on-disk path of a raw dataset file, validated against traversal."""
    return _safe_join(datasets_dir(project_uid), rel)


def runtime_env(project_uid: str) -> dict[str, str]:
    """The LINKR_* variables injected into every kernel/terminal so scripts reach
    the IDE working dir, the datasets dir, and the project root by name rather than
    a hard-coded absolute path (the binding can be re-pointed without editing code).
    Bindings must be primed first (prime_binding)."""
    return {
        "LINKR_IDE": str(scripts_dir(project_uid)),
        "LINKR_DATASETS": str(datasets_dir(project_uid)),
        "LINKR_PROJECT": str(project_dir(project_uid)),
    }


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


# --- scripts/ -------------------------------------------------------------

def script_path(project_uid: str, rel: str) -> Path:
    return _safe_join(scripts_dir(project_uid), rel)


def scan_scripts(project_uid: str) -> list[dict]:
    """Walk the IDE working dir and return its tree with real files/folders as the
    top-level nodes (no synthetic root: the working dir IS the root, matching what
    a terminal opened in it sees). Node fields: id, name, type, parentId, path,
    language, order. Content is read separately (read_script)."""
    root = scripts_dir(project_uid)
    return _scan_tree(root, "ide", parent_id=None)


def read_script(project_uid: str, rel: str) -> str:
    p = script_path(project_uid, rel)
    return p.read_text(encoding="utf-8") if p.is_file() else ""


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
