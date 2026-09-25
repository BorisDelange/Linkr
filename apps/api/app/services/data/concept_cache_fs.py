"""Server-side materialized cache of the concept list for a data source.

The Concepts page used to run its list query (concepts + a GROUP-BY count join)
against the live source on every page/filter/sort — slow on a large warehouse and
serialised behind the source's pooled connection. Instead we materialize the
FULL flattened list (one row per concept: id, name, code, vocabulary, …, plus
record_count / patient_count) to a Parquet file once, and serve every page read
from that local Parquet — no source round-trip, no GROUP BY per page.

One cache per (source, principal): a file database has a single one shared by
everyone; an external database one per user, since each user's own grants decide
what the list query could see. Writes are atomic (temp file then
rename), so a refresh never exposes a half-written cache: readers see either the
previous complete cache or the new one.
"""

import contextlib
import re

from app.config import settings
from app.services.data import db_connect

# Source ids are client UUIDs; validate before putting one in a filesystem path.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_PRINCIPAL_RE = re.compile(r"^(user:[0-9]{1,18})?$")


def _cache_root():
    d = settings.data_path / "_cache" / "concept-lists"
    d.mkdir(parents=True, exist_ok=True)
    return d


def cache_path(source_id: str, principal: str):
    if not _ID_RE.match(source_id):
        raise ValueError(f"invalid source id: {source_id!r}")
    if not _PRINCIPAL_RE.match(principal):
        raise ValueError(f"invalid principal: {principal!r}")
    suffix = f"~{principal.replace(':', '-')}" if principal else ""
    return _cache_root() / f"{source_id}{suffix}.parquet"


def exists(source_id: str, principal: str) -> bool:
    return cache_path(source_id, principal).is_file()


def refreshed_at(source_id: str, principal: str) -> float | None:
    """mtime of the cache (epoch seconds) — the "last refreshed" time — or None."""
    p = cache_path(source_id, principal)
    return p.stat().st_mtime if p.is_file() else None


def refresh(
    config: dict,
    password: str | None,
    files: list[tuple[str, str]] | None,
    known: list[str] | None,
    select_sql: str,
    source_id: str,
    principal: str,
) -> float:
    """Materialize the concept list to the cache Parquet. `select_sql` is the full
    (unpaginated) list query built by the frontend. Returns the new mtime."""
    dest = cache_path(source_id, principal)
    db_connect.materialize_parquet(config, password, files, known, select_sql, str(dest))
    return dest.stat().st_mtime


def query_page(source_id: str, principal: str, sql: str) -> list[dict]:
    """Run a page/filter/sort query against the cached Parquet (exposed as the view
    `concepts`). Raises FileNotFoundError if no cache has been built yet."""
    p = cache_path(source_id, principal)
    if not p.is_file():
        raise FileNotFoundError("no concept cache for this source")
    return db_connect.query_cached_parquet(p.as_posix(), sql)


def invalidate(source_id: str, principal: str | None = None) -> None:
    """Drop the cache — every principal's (source changed) or one user's (their
    login changed). Safe if absent."""
    if not _ID_RE.match(source_id):
        return
    if principal is not None:
        with contextlib.suppress(ValueError):
            cache_path(source_id, principal).unlink(missing_ok=True)
        return
    root = _cache_root()
    (root / f"{source_id}.parquet").unlink(missing_ok=True)
    for path in root.glob(f"{source_id}~*.parquet"):
        path.unlink(missing_ok=True)
