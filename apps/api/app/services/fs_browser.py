"""Server file-browser. Two callers, two shapes:

- the project **Folders** settings pick a folder to bind the IDE working dir /
  datasets dir to (``validate_binding_path``);
- a **database** points at data already on the server — a DuckDB/SQLite file or a
  Parquet folder — instead of uploading it (``validate_source_path``);
- a **dataset import** or an **IDE upload** copies a server file into the project
  instead of uploading it from the user's machine (``validate_import_source``).

This exposes the server filesystem, so every route using it is permission-gated
(``project-settings:write`` for a binding, ``databases:write`` for a source) and
every path is validated against the configured browse roots
(``settings.fs_browse_roots``; empty = whole filesystem, which is the deployment's
responsibility to mount safely — the RStudio Server model). Picker-side checks are
a convenience: the boundary is re-enforced wherever a path is persisted.

With empty roots, anyone holding ``databases:write`` can create a ``.duckdb``
wherever the server process can write (``check_new_database_file``), so a
multi-user deployment should set the roots.

An import never exceeds what its user could already read: with empty roots it
needs code execution on the project (a script reads the same files), and the
kernel-only system folders, Linkr's own data folder and the folders other projects
are bound to are always refused — the copy runs in the API process, which can read
what kernels cannot. A binding and a database's `serverPath` answer to the same
refusal (``FolderScope``): either one would otherwise re-expose those folders
through the IDE file routes or the query route.
"""

import os
import shutil
import stat
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path
from typing import TYPE_CHECKING, BinaryIO, cast

from app.config import settings

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.models.project import Project
    from app.models.user import User


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

    status_code = 400


class FsImportForbidden(FsBrowseError):
    status_code = 403


class FsImportTooLarge(FsBrowseError):
    status_code = 413


# Pseudo-filesystems: /proc/self/environ alone would hand over the API's secrets.
_SYSTEM_DIRS = (Path("/proc"), Path("/sys"), Path("/dev"))

IMPORT_NEEDS_EXECUTION = (
    "Importing from anywhere on the server requires code execution on this project. "
    "Ask an administrator to configure browse roots to import without it."
)
SYSTEM_PATH_REFUSED = "System folders (/proc, /sys, /dev) cannot be used"
DATA_DIR_REFUSED = "Linkr's data folder cannot be used"
OTHER_PROJECT_REFUSED = "Another project's folders cannot be used"
BROWSE_ROOT_REFUSED = "A whole browse root cannot be bound to a single project"


def validate_binding_path(path: str, scope: "FolderScope") -> None:
    """Enforce the SAME boundary the browse routes enforce, at the point a path
    is actually PERSISTED as a project's ide/scripts/datasets binding. The picker
    validates client-side, but the bind is a plain project PATCH — so without this
    an authorized user could set an arbitrary absolute path (e.g. /root, ~/.ssh)
    that the browse-root confinement never sees, yielding arbitrary server file
    read/write via the IDE/dataset file routes. Empty/None clears the binding
    (falls back to the default dir) and is always allowed.

    A bound folder counts as the project's own for imports, so it must not
    overlap Linkr's data folder, a system folder, or (without
    `project-folders:read`) another project's binding — nor claim a whole browse
    root, which would make every file in it another project's for everyone else.
    Raises FsBrowseError, whose `status_code` the route answers with."""
    if not path:
        return
    if not settings.enable_code_execution:
        raise FsBrowseError("File-system bindings are disabled on this deployment")
    target = Path(path).expanduser().resolve()
    if not _within_roots(target):
        raise FsBrowseError("Path is outside the allowed browse roots")
    if not target.is_dir():
        raise FsBrowseError("Bound path is not an existing folder")
    reason = _overlap_refusal(target, scope)
    if reason is None and not scope.sees_project_folders and _identity(target) in scope._root_ancestry:
        reason = BROWSE_ROOT_REFUSED
    if reason:
        raise FsImportForbidden(reason)


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


def validate_source_path(path: str, scope: "FolderScope") -> None:
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

    The query route reads whatever the source points at, so it must not overlap
    Linkr's data folder (its own database holds every password hash), a system
    folder, or — without `project-folders:read` — a folder bound to a project.

    Raises FsBrowseError, whose `status_code` the route answers with."""
    if not path:
        return
    target = Path(path).expanduser().resolve()
    if not _within_roots(target):
        raise FsBrowseError("Path is outside the allowed browse roots")
    reason = _overlap_refusal(target, scope)
    if reason:
        raise FsImportForbidden(reason)
    if not target.exists():
        raise FsBrowseError("Server path does not exist")
    if not (target.is_file() or target.is_dir()):
        raise FsBrowseError("Server path is neither a file nor a folder")
    if not os.access(target, os.R_OK):
        raise FsBrowseError("Server path is not readable by the server")


def reserved_refusal(path: str | Path) -> str | None:
    """Why `path` may never be read on anyone's behalf, whoever asks: it is, is
    inside or contains Linkr's data folder or a system folder. The check a
    `serverPath` persisted before the rule existed still gets when it is attached."""
    return _reserved_refusal(Path(path).expanduser().resolve(), FolderScope(whole_fs_allowed=False))


def files_under(root: Path, suffixes: tuple[str, ...] | None = None) -> list[Path]:
    """The files below `root`, recursively, sorted case-insensitively, minus any
    symlink leading into a reserved place (`reserved_refusal`). `rglob` does not
    descend into symlinked folders, so only symlinked files can leave `root`."""
    found = (
        p
        for p in root.rglob("*")
        if p.is_file()
        and (suffixes is None or p.suffix.lower() in suffixes)
        and not (p.is_symlink() and reserved_refusal(p))
    )
    return sorted(found, key=lambda p: str(p).lower())


async def whole_fs_import_allowed(db: "AsyncSession", project: "Project", user: "User") -> bool:
    """Whether `user` may import from anywhere when no browse roots are set: only
    if they could already read the same files with a script on `project`."""
    from app.core.permissions import has_project_permission

    return settings.enable_code_execution and await has_project_permission(db, project, user, "ide:execute")


def _identity(path: Path) -> tuple[int, int] | None:
    try:
        st = path.stat()
    except OSError:
        return None
    return st.st_dev, st.st_ino


def _identities(paths: Iterable[str | Path]) -> set[tuple[int, int]]:
    out = set()
    for p in paths:
        ident = _identity(Path(p).expanduser())
        if ident is not None:
            out.add(ident)
    return out


def _lineage(target: Path) -> list[tuple[int, int]]:
    """Identities of `target` and every folder above it, nearest first. Compared by
    inode, not by string: on a case-insensitive filesystem `…/linkrdata` IS
    `…/LinkrData`."""
    return [ident for p in (target, *target.parents) if (ident := _identity(p)) is not None]


@dataclass(frozen=True)
class FolderScope:
    """What one user may read on the server for one project (an import, a
    binding) or for none (a database). `whole_fs_allowed`: no browse roots needed
    (the user could read the file with a script). `foreign_bound`: the folders
    other projects are bound to; `own_bound`: the project's. For an import the
    nearest bound folder above a file decides, so a folder both projects are bound
    to (only an administrator can set that up) stays readable, and a broad own
    binding does not open another project's folder nested in it.

    A foreign binding at or above a browse root is not treated as private: a
    project cannot own a whole root (`validate_binding_path`), and one bound
    before that rule would otherwise make every file in the root another
    project's for everyone else."""

    whole_fs_allowed: bool
    foreign_bound: frozenset[str] = frozenset()
    own_bound: frozenset[str] = frozenset()
    sees_project_folders: bool = False

    @cached_property
    def _root_ancestry(self) -> set[tuple[int, int]]:
        return {ident for root in _browse_roots() for ident in _lineage(root)}

    @cached_property
    def _foreign_ids(self) -> set[tuple[int, int]]:
        return _identities(self.foreign_bound) - self._root_ancestry

    @cached_property
    def _foreign_ancestry(self) -> set[tuple[int, int]]:
        return {
            ident
            for p in self.foreign_bound
            if _identity(Path(p).expanduser()) in self._foreign_ids
            for ident in _lineage(Path(p).expanduser().resolve())
        }

    @cached_property
    def _own_ids(self) -> set[tuple[int, int]]:
        return _identities(self.own_bound)

    @cached_property
    def _data_dir_ids(self) -> set[tuple[int, int]]:
        return _identities([settings.data_path])

    @cached_property
    def _data_dir_ancestry(self) -> set[tuple[int, int]]:
        return set(_lineage(Path(settings.data_path).expanduser().resolve()))

    @cached_property
    def _system_ids(self) -> set[tuple[int, int]]:
        return _identities(_SYSTEM_DIRS)

    @cached_property
    def _system_ancestry(self) -> set[tuple[int, int]]:
        return {ident for d in _SYSTEM_DIRS for ident in _lineage(d)}


async def import_scope(db: "AsyncSession", project: "Project | None", user: "User") -> FolderScope:
    """`user`'s scope for `project`, or for a database (`project` None: every
    binding is another project's, and the whole filesystem is never open)."""
    from sqlalchemy import select

    from app.core.permissions import has_global_permission
    from app.models.project import Project as ProjectModel

    whole_fs_allowed = project is not None and await whole_fs_import_allowed(db, project, user)
    if await has_global_permission(db, user, "project-folders:read"):
        return FolderScope(whole_fs_allowed=whole_fs_allowed, sees_project_folders=True)

    rows = await db.execute(
        select(ProjectModel.uid, ProjectModel.ide_path, ProjectModel.scripts_path, ProjectModel.datasets_path)
    )
    own_uid = project.uid if project is not None else None
    foreign: set[str] = set()
    own: set[str] = set()
    for uid, *paths in rows.all():
        (own if uid == own_uid else foreign).update(p for p in paths if p)
    return FolderScope(
        whole_fs_allowed=whole_fs_allowed,
        foreign_bound=frozenset(foreign),
        own_bound=frozenset(own),
    )


def _reserved_refusal(target: Path, scope: FolderScope, lineage: list[tuple[int, int]] | None = None) -> str | None:
    """`target` is, is inside or contains a system folder or Linkr's data folder."""
    lineage = _lineage(target) if lineage is None else lineage
    if any(target == d or d in target.parents for d in _SYSTEM_DIRS) or scope._system_ids.intersection(lineage):
        return SYSTEM_PATH_REFUSED
    if scope._data_dir_ids.intersection(lineage):
        return DATA_DIR_REFUSED
    ident = _identity(target)
    if ident is None:
        return None
    if ident in scope._system_ancestry:
        return SYSTEM_PATH_REFUSED
    if ident in scope._data_dir_ancestry:
        return DATA_DIR_REFUSED
    return None


def _overlap_refusal(target: Path, scope: FolderScope) -> str | None:
    """Why `target` (resolved) may not be persisted as a binding or a source: the
    reserved places, then — unless the user sees every project's folders — a
    foreign binding it is, is inside or contains."""
    lineage = _lineage(target)
    reason = _reserved_refusal(target, scope, lineage)
    if reason or scope.sees_project_folders:
        return reason
    if scope._foreign_ids.intersection(lineage) or _identity(target) in scope._foreign_ancestry:
        return OTHER_PROJECT_REFUSED
    return None


def _import_refusal(target: Path, scope: FolderScope) -> str | None:
    """Why `target` (resolved) may never be imported from or listed for an import."""
    if any(target == d or d in target.parents for d in _SYSTEM_DIRS):
        return SYSTEM_PATH_REFUSED
    lineage = _lineage(target)
    if scope._system_ids.intersection(lineage):
        return SYSTEM_PATH_REFUSED
    if scope._data_dir_ids.intersection(lineage):
        return DATA_DIR_REFUSED
    for ident in lineage:
        if ident in scope._own_ids:
            return None
        if ident in scope._foreign_ids:
            return OTHER_PROJECT_REFUSED
    return None


def _check_import_scope(scope: FolderScope) -> None:
    if not _browse_roots() and not scope.whole_fs_allowed:
        raise FsImportForbidden(IMPORT_NEEDS_EXECUTION)


def import_list_dir(path: str, extensions: list[str] | None, scope: FolderScope) -> dict:
    """`list_dir` for the import picker: the same boundary `validate_import_source`
    enforces, so the picker never offers a folder or file it would then refuse."""
    _check_import_scope(scope)
    if path:
        reason = _import_refusal(Path(path).expanduser().resolve(), scope)
        if reason:
            raise FsImportForbidden(reason)
    listing = list_dir(path, True, extensions)
    listing["entries"] = [e for e in listing["entries"] if _import_refusal(Path(e["path"]).resolve(), scope) is None]
    return listing


def validate_import_source(path: str, scope: FolderScope) -> Path:
    """Check a server file a user copies INTO a project — a dataset import or an
    IDE upload — and return it resolved. Inside the browse roots (or, with none
    configured, only for a user allowed to run code: `scope.whole_fs_allowed`),
    never a system folder, an existing readable file within the upload size cap,
    outside Linkr's own data folder — it holds the sealing key, the blob store and
    every other project's files, which a copy would hand to anyone holding
    datasets/IDE write on *one* project — and outside the folders other projects
    are bound to, for the same reason.

    Raises FsBrowseError, whose `status_code` the route answers with."""
    if not path:
        raise FsBrowseError("No server file chosen")
    _check_import_scope(scope)
    target = Path(path).expanduser().resolve()
    if not _within_roots(target):
        raise FsBrowseError("Path is outside the allowed browse roots")
    reason = _import_refusal(target, scope)
    if reason:
        raise FsImportForbidden(reason)
    if not target.is_file():
        raise FsBrowseError("Server path is not an existing file")
    if not os.access(target, os.R_OK):
        raise FsBrowseError("Server path is not readable by the server")
    if target.stat().st_size > settings.max_upload_mb * 1024 * 1024:
        raise FsImportTooLarge(f"File exceeds the {settings.max_upload_mb} MB upload limit.")
    return target


def _fd_path(fd: int) -> Path | None:
    """Where the open file `fd` actually lives, or None where the OS cannot say."""
    if sys.platform == "darwin":
        import fcntl

        try:
            raw = fcntl.fcntl(fd, fcntl.F_GETPATH, bytes(1024))
        except OSError:
            return None
        return Path(os.fsdecode(raw.split(b"\0", 1)[0]))
    try:
        return Path(os.readlink(f"/proc/self/fd/{fd}"))
    except OSError:
        return None


class _CappedReader:
    """A file that raises FsImportTooLarge once more than `limit` bytes were read:
    the size checked before the copy says nothing of a file still growing."""

    def __init__(self, f: BinaryIO, limit: int) -> None:
        self._f = f
        self._limit = limit
        self._read = 0

    def read(self, size: int | None = -1) -> bytes:
        room = self._limit - self._read + 1
        chunk = self._f.read(room if size is None or size < 0 else min(size, room))
        self._read += len(chunk)
        if self._read > self._limit:
            raise FsImportTooLarge(f"File exceeds the {settings.max_upload_mb} MB upload limit.")
        return chunk

    def fileno(self) -> int:
        return self._f.fileno()

    def close(self) -> None:
        self._f.close()

    def __enter__(self) -> "_CappedReader":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def open_import_source(path: str, scope: FolderScope) -> BinaryIO:
    """`validate_import_source`, then open the file and check what was OPENED: a
    path swapped for a symlink between the check and the open must not slip a
    refused file through, nor a FIFO (opened non-blocking, then refused) hang the
    worker. Reading past the upload cap raises FsImportTooLarge. The caller copies
    from (and closes) the returned file."""
    target = validate_import_source(path, scope)
    checked = _identity(target)
    try:
        fd = os.open(target, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0))
    except OSError as exc:
        raise FsBrowseError("Server file changed while it was being imported") from exc
    f = os.fdopen(fd, "rb")
    try:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or (st.st_dev, st.st_ino) != checked:
            raise FsBrowseError("Server file changed while it was being imported")
        if st.st_size > settings.max_upload_mb * 1024 * 1024:
            raise FsImportTooLarge(f"File exceeds the {settings.max_upload_mb} MB upload limit.")
        opened = _fd_path(f.fileno())
        if opened is not None:
            if not _within_roots(opened.resolve()):
                raise FsBrowseError("Path is outside the allowed browse roots")
            reason = _import_refusal(opened.resolve(), scope)
            if reason:
                raise FsImportForbidden(reason)
    except BaseException:
        f.close()
        raise
    return cast(BinaryIO, _CappedReader(f, settings.max_upload_mb * 1024 * 1024))


DATABASE_FILE_SUFFIX = ".duckdb"


def check_new_database_file(path: str) -> dict:
    """Check `path` can receive a NEW DuckDB file that Linkr will own: inside the
    browse roots, named `*.duckdb`, in an existing writable folder, and not already
    there. Same machine-readable reasons as `validate_dir`.

    Refusing an existing file is the whole point: Linkr writes into a file it owns
    and a rebuild deletes it, so accepting one would let a user pick someone
    else's database — or any file — and have it overwritten. Not gated on
    `enable_code_execution`, like `validate_source_path`: creating a database is
    not running code."""
    if not path:
        return {"ok": False, "reason": "empty"}
    raw = Path(path).expanduser()
    if not raw.is_absolute():
        return {"ok": False, "reason": "not_absolute"}
    if raw.suffix.lower() != DATABASE_FILE_SUFFIX or raw.name == DATABASE_FILE_SUFFIX:
        return {"ok": False, "reason": "wrong_extension"}
    # The file does not exist yet, so only its folder can be resolved: resolving
    # the folder is what stops a symlinked folder from escaping a root.
    folder = raw.parent.resolve()
    target = folder / raw.name
    if not _within_roots(target):
        return {"ok": False, "reason": "outside_roots"}
    if not folder.is_dir():
        return {"ok": False, "reason": "not_found", "path": str(folder)}
    if not os.access(folder, os.W_OK):
        return {"ok": False, "reason": "not_writable", "path": str(folder)}
    # A leftover `<name>.wal` counts as the file: DuckDB replays it into
    # whatever database next opens under that name.
    wal = target.with_name(target.name + ".wal")
    for taken in (target, wal):
        if taken.exists() or taken.is_symlink():
            return {"ok": False, "reason": "exists", "path": str(taken)}
    return {"ok": True, "path": str(target)}


def validate_new_database_file(path: str) -> Path:
    """`check_new_database_file` as a guard: the resolved path, or FsBrowseError."""
    result = check_new_database_file(path)
    if not result["ok"]:
        raise FsBrowseError(f"Cannot create the database file here: {result['reason']}")
    return Path(result["path"])


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
