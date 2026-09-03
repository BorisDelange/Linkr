"""Server file-browser. Two callers, two shapes:

- the project **Folders** settings pick a folder to bind the IDE working dir /
  datasets dir to (``validate_binding_path``);
- a **database** points at data already on the server — a DuckDB/SQLite file or a
  Parquet folder — instead of uploading it (``validate_source_path``).

This exposes the server filesystem, so every route using it is permission-gated
(``project-settings:write`` for a binding, ``databases:write`` for a source) and
every path is validated against the configured browse roots
(``settings.fs_browse_roots``; empty = whole filesystem, which is the deployment's
responsibility to mount safely — the RStudio Server model). Picker-side checks are
a convenience: the boundary is re-enforced wherever a path is persisted.
"""

import os
import shutil
from pathlib import Path

from app.config import settings


def _browse_roots() -> list[Path]:
    raw = (settings.fs_browse_roots or "").strip()
    if not raw:
        return []
    return [Path(p.strip()).expanduser().resolve() for p in raw.split(",") if p.strip()]


def _within_roots(target: Path) -> bool:
    """True if `target` is inside (or equal to) one of the configured roots. No
    configured roots → the whole filesystem is allowed."""
    roots = _browse_roots()
    if not roots:
        return True
    return any(target == r or r in target.parents for r in roots)


class FsBrowseError(ValueError):
    """A browse/validate request that must surface as a 4xx (not a 500)."""


def validate_binding_path(path: str) -> None:
    """Enforce the SAME boundary the browse routes enforce, at the point a path
    is actually PERSISTED as a project's ide/scripts/datasets binding. The picker
    validates client-side, but the bind is a plain project PATCH — so without this
    an authorized user could set an arbitrary absolute path (e.g. /root, ~/.ssh)
    that the browse-root confinement never sees, yielding arbitrary server file
    read/write via the IDE/dataset file routes. Empty/None clears the binding
    (falls back to the default dir) and is always allowed. Raises FsBrowseError
    (surfaced as 400) on rejection."""
    if not path:
        return
    if not settings.enable_code_execution:
        raise FsBrowseError("File-system bindings are disabled on this deployment")
    target = Path(path).expanduser().resolve()
    if not _within_roots(target):
        raise FsBrowseError("Path is outside the allowed browse roots")
    if not target.is_dir():
        raise FsBrowseError("Bound path is not an existing folder")


def _resolve(path: str) -> Path:
    """Resolve a user-supplied absolute path, rejecting anything outside the
    configured browse roots. Symlinks are resolved so they can't escape a root."""
    if not path:
        # Empty path → the first configured root, else the filesystem root.
        roots = _browse_roots()
        return roots[0] if roots else Path("/")
    target = Path(path).expanduser().resolve()
    if not _within_roots(target):
        raise FsBrowseError("Path is outside the allowed browse roots")
    return target


def _matches_extensions(name: str, extensions: list[str] | None) -> bool:
    if not extensions:
        return True
    lowered = name.lower()
    return any(lowered.endswith(ext) for ext in extensions)


def _normalize_extensions(extensions: list[str] | None) -> list[str] | None:
    """Lowercase, dot-prefixed suffixes. A display filter only — never a security
    control (the caller still validates the chosen path)."""
    if not extensions:
        return None
    out = []
    for raw in extensions:
        ext = raw.strip().lower()
        if not ext:
            continue
        out.append(ext if ext.startswith(".") else f".{ext}")
    return out or None


def list_dir(
    path: str,
    include_files: bool = False,
    extensions: list[str] | None = None,
) -> dict:
    """List the immediate children of `path`. Subdirectories are always listed;
    files only when `include_files` (the folder picker hides them, the file picker
    shows them, and both list dirs first so navigation stays identical). Files may
    be narrowed to `extensions` — a display filter, not a boundary. Returns the
    resolved path, its parent (None at a root boundary), and the children sorted
    case-insensitively with directories first."""
    target = _resolve(path)
    if not target.exists():
        raise FsBrowseError("Folder not found")
    if not target.is_dir():
        raise FsBrowseError("Not a folder")
    exts = _normalize_extensions(extensions)
    try:
        children = [e for e in target.iterdir() if not e.name.startswith(".")]
        dirs = sorted((e for e in children if e.is_dir()), key=lambda e: e.name.lower())
        files = (
            sorted(
                (e for e in children if e.is_file() and _matches_extensions(e.name, exts)),
                key=lambda e: e.name.lower(),
            )
            if include_files
            else []
        )
    except PermissionError as exc:
        raise FsBrowseError("Permission denied") from exc
    parent = target.parent
    parent_str = str(parent) if parent != target and _within_roots(parent) else None

    def _entry(e: Path, is_dir: bool) -> dict:
        row = {"name": e.name, "path": str(e), "isDir": is_dir}
        if not is_dir:
            # A file listed but unreadable is shown disabled rather than hidden,
            # so a wrong-permissions mount is diagnosable from the picker.
            try:
                row["size"] = e.stat().st_size
            except OSError:
                row["size"] = None
            row["readable"] = os.access(e, os.R_OK)
        return row

    return {
        "path": str(target),
        "parent": parent_str,
        "entries": [_entry(e, True) for e in dirs] + [_entry(e, False) for e in files],
    }


def validate_file(path: str, extensions: list[str] | None = None) -> dict:
    """Check a chosen file is usable as a data source: inside the browse roots,
    an existing readable file, and (when given) one of `extensions`. Mirrors
    `validate_dir`'s machine-readable reasons so the UI can localize."""
    if not path:
        return {"ok": False, "reason": "empty"}
    try:
        target = _resolve(path)
    except FsBrowseError:
        return {"ok": False, "reason": "outside_roots"}
    if not target.exists():
        return {"ok": False, "reason": "not_found", "path": str(target)}
    if not target.is_file():
        return {"ok": False, "reason": "not_a_file", "path": str(target)}
    if not os.access(target, os.R_OK):
        return {"ok": False, "reason": "not_readable", "path": str(target)}
    if not _matches_extensions(target.name, _normalize_extensions(extensions)):
        return {"ok": False, "reason": "wrong_extension", "path": str(target)}
    return {"ok": True, "path": str(target)}


def validate_readable_dir(path: str) -> dict:
    """Like `validate_dir`, but requires only READ access. A Parquet folder is
    attached read-only, so demanding write permission (as a project binding does)
    would reject a perfectly good read-only data mount."""
    if not path:
        return {"ok": False, "reason": "empty"}
    try:
        target = _resolve(path)
    except FsBrowseError:
        return {"ok": False, "reason": "outside_roots"}
    if not target.exists():
        return {"ok": False, "reason": "not_found", "path": str(target)}
    if not target.is_dir():
        return {"ok": False, "reason": "not_a_dir", "path": str(target)}
    if not os.access(target, os.R_OK):
        return {"ok": False, "reason": "not_readable", "path": str(target)}
    return {"ok": True, "path": str(target)}


def validate_source_path(path: str) -> None:
    """Enforce the browse-root boundary where a database's `serverPath` is
    PERSISTED (create and update alike). The picker's validation is a convenience,
    not a control: the config is written by a plain create/PATCH, so without this
    a hand-made request could point a source at any server file and read it back
    through the query route. Accepts a file (DuckDB/SQLite) or a directory (a
    Parquet folder).

    Deliberately NOT gated on `enable_code_execution`, unlike
    `validate_binding_path`: binding a project's IDE folder *is* code execution,
    whereas attaching a database read-only is not — a deployment that turned the
    IDE off must still be able to point Linkr at its own data.

    Raises FsBrowseError (surfaced as 400) on rejection."""
    if not path:
        return
    target = Path(path).expanduser().resolve()
    if not _within_roots(target):
        raise FsBrowseError("Path is outside the allowed browse roots")
    if not target.exists():
        raise FsBrowseError("Server path does not exist")
    if not (target.is_file() or target.is_dir()):
        raise FsBrowseError("Server path is neither a file nor a folder")
    if not os.access(target, os.R_OK):
        raise FsBrowseError("Server path is not readable by the server")


def validate_dir(path: str) -> dict:
    """Check a chosen folder is bindable: it must EXIST, be a directory, and be
    writable by the server process (no mkdir — the admin prepares the folder). The
    return carries a machine-readable reason so the UI can localize the message."""
    if not path:
        return {"ok": False, "reason": "empty"}
    try:
        target = _resolve(path)
    except FsBrowseError:
        return {"ok": False, "reason": "outside_roots"}
    if not target.exists():
        return {"ok": False, "reason": "not_found", "path": str(target)}
    if not target.is_dir():
        return {"ok": False, "reason": "not_a_dir", "path": str(target)}
    # A writable dir is one we can create entries in; probe with os.access(W_OK).
    if not os.access(target, os.W_OK):
        return {"ok": False, "reason": "not_writable", "path": str(target)}
    return {"ok": True, "path": str(target)}


def copy_tree(src: str, dst: str, on_conflict: str) -> dict:
    """Copy the contents of `src` into `dst` (used on re-bind to carry the old
    folder's files over). `on_conflict` ∈ {ignore, overwrite, keep_both}: per file,
    ignore keeps dst's version, overwrite replaces it, keep_both writes a suffixed
    copy. Both paths are validated against the browse roots. Returns counts."""
    if on_conflict not in ("ignore", "overwrite", "keep_both"):
        raise FsBrowseError("Invalid conflict strategy")
    src_p = _resolve(src)
    dst_p = _resolve(dst)
    if not src_p.is_dir():
        raise FsBrowseError("Source folder not found")
    if not dst_p.is_dir():
        raise FsBrowseError("Destination folder not found")
    if src_p == dst_p or src_p in dst_p.parents:
        raise FsBrowseError("Destination is inside the source folder")

    copied = 0
    skipped = 0
    overwritten = 0

    def _unique(target: Path) -> Path:
        stem, suffix = target.stem, target.suffix
        i = 2
        cand = target.with_name(f"{stem} ({i}){suffix}")
        while cand.exists():
            i += 1
            cand = target.with_name(f"{stem} ({i}){suffix}")
        return cand

    for root, _dirs, files in os.walk(src_p):
        rel = Path(root).relative_to(src_p)
        out_dir = dst_p / rel
        out_dir.mkdir(parents=True, exist_ok=True)
        for name in files:
            src_file = Path(root) / name
            dst_file = out_dir / name
            if dst_file.exists():
                if on_conflict == "ignore":
                    skipped += 1
                    continue
                if on_conflict == "overwrite":
                    shutil.copy2(src_file, dst_file)
                    overwritten += 1
                    continue
                dst_file = _unique(dst_file)  # keep_both
            shutil.copy2(src_file, dst_file)
            copied += 1

    return {"copied": copied, "skipped": skipped, "overwritten": overwritten}
