"""Server-side materialized cache of the concept list for a data source.

The Concepts page used to run its list query (concepts + a GROUP-BY count join)
against the live source on every page/filter/sort — slow on a large warehouse and
serialised behind the source's pooled connection. Instead we materialize the
FULL flattened list (one row per concept: id, name, code, vocabulary, …, plus
record_count / patient_count) to a Parquet file once, and serve every page read
from that local Parquet — no source round-trip, no GROUP BY per page.

Shared across users (one cache per source). Writes are atomic (temp file then
rename), so a refresh never exposes a half-written cache: readers see either the
previous complete cache or the new one.
"""

import re

from app.config import settings
from app.services.data import db_connect

# Source ids are client UUIDs; validate before putting one in a filesystem path.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _cache_root():
    d = settings.data_path / "_cache" / "concept-lists"
    d.mkdir(parents=True, exist_ok=True)
    return d


def cache_path(source_id: str):
    if not _ID_RE.match(source_id):
        raise ValueError(f"invalid source id: {source_id!r}")
    return _cache_root() / f"{source_id}.parquet"


def exists(source_id: str) -> bool:
    return cache_path(source_id).is_file()


def refreshed_at(source_id: str) -> float | None:
    """mtime of the cache (epoch seconds) — the "last refreshed" time — or None."""
    p = cache_path(source_id)
    return p.stat().st_mtime if p.is_file() else None


def refresh(
    config: dict,
    password: str | None,
    files: list[tuple[str, str]] | None,
    known: list[str] | None,
    select_sql: str,
    source_id: str,
) -> float:
    """Materialize the concept list to the cache Parquet. `select_sql` is the full
    (unpaginated) list query built by the frontend. Returns the new mtime."""
    dest = cache_path(source_id)
    db_connect.materialize_parquet(config, password, files, known, select_sql, str(dest))
    return dest.stat().st_mtime


def query_page(source_id: str, sql: str) -> list[dict]:
    """Run a page/filter/sort query against the cached Parquet (exposed as the view
    `concepts`). Raises FileNotFoundError if no cache has been built yet."""
    p = cache_path(source_id)
    if not p.is_file():
        raise FileNotFoundError("no concept cache for this source")
    return db_connect.query_cached_parquet(p.as_posix(), sql)


def invalidate(source_id: str) -> None:
    """Drop the cache (source changed). Safe if absent."""
    try:
        cache_path(source_id).unlink(missing_ok=True)
    except ValueError:
        pass
