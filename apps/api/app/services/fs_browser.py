"""Server file-browser for the project Folders settings — lets an authorized user
pick the absolute server folder a project's IDE working dir / datasets dir binds
to. This exposes the server filesystem, so every route using it is gated on
``project-settings:write`` and every path is validated against the configured
browse roots (``settings.fs_browse_roots``; empty = whole filesystem, which is the
deployment's responsibility to mount safely — the RStudio Server model)."""

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


def list_dir(path: str) -> dict:
    """List the immediate subdirectories of `path` (directories only — the picker
    chooses folders, not files). Returns the resolved path, its parent (None at a
    root boundary), and the child dirs sorted case-insensitively."""
    target = _resolve(path)
    if not target.exists():
        raise FsBrowseError("Folder not found")
    if not target.is_dir():
        raise FsBrowseError("Not a folder")
    try:
        entries = sorted(
            (e for e in target.iterdir() if e.is_dir() and not e.name.startswith(".")),
            key=lambda e: e.name.lower(),
        )
    except PermissionError as exc:
        raise FsBrowseError("Permission denied") from exc
    parent = target.parent
    parent_str = str(parent) if parent != target and _within_roots(parent) else None
    return {
        "path": str(target),
        "parent": parent_str,
        "entries": [{"name": e.name, "path": str(e)} for e in entries],
    }


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
