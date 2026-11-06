"""Entity ids that name a folder on disk.

Project uids, workspace ids and the ids of every versionable entity become one
directory under the data dir (``projects/<uid>``, ``<kind>/<id>/versioning``,
``vocabularies/<workspace id>``…), and deleting the entity removes that directory.
Such an id must therefore be a single safe path segment: it starts with a letter
or a digit (never ``.`` nor ``..``) and holds no separator. ``SAFE_ID_PATTERN`` is
checked where the id is accepted (API schemas); ``child_dir`` again where it is
joined to a path, so a row stored before the check cannot reach outside its root.
"""

import re
from pathlib import Path
from typing import Annotated

from pydantic import AfterValidator, StringConstraints

SAFE_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
_SAFE_ID_RE = re.compile(SAFE_ID_PATTERN)

SafeId = Annotated[str, StringConstraints(pattern=SAFE_ID_PATTERN)]

_NOT_IN_A_SEGMENT = re.compile(r"[/\\?#%\x00-\x1f]")


def _one_path_segment(value: str) -> str:
    if not value or value in (".", "..") or _NOT_IN_A_SEGMENT.search(value):
        raise ValueError("an id must be a single path segment")
    return value


# A row id the client later puts in a URL: exactly one path segment, whatever the
# route's id format. Less strict than SafeId, which also names folders.
SegmentId = Annotated[str, AfterValidator(_one_path_segment)]


class UnsafePathSegment(ValueError):
    pass


def check_segment(value: object) -> str:
    """`value` when it may name a single folder, else UnsafePathSegment."""
    if not isinstance(value, str) or not _SAFE_ID_RE.fullmatch(value):
        raise UnsafePathSegment(f"Invalid identifier: {value!r}")
    return value


def is_safe_segment(value: object) -> bool:
    return isinstance(value, str) and _SAFE_ID_RE.fullmatch(value) is not None


def child_dir(root: Path, segment: str) -> Path:
    """`root / segment`, which must resolve to a direct child of `root`."""
    check_segment(segment)
    path = root / segment
    base = root.resolve()
    if path.resolve().parent != base:
        raise UnsafePathSegment(f"Invalid identifier: {segment!r}")
    return path
