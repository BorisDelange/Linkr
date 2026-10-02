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

The counts are computed in units — one query each, short enough for any HTTP
timeout — that the browser drives one at a time (`concept-count-plan.ts`). Each
unit writes its own small Parquet of `(dict_key, concept_id, record_count,
patient_count)` into the run folder, next to a manifest the client owns. A
resume skips the units whose file exists, and `assemble` joins the dictionaries
to whatever units are done so far, so the list is usable before the run ends.
"""

import contextlib
import json
import os
import re
import shutil
import uuid

from app.config import settings
from app.services.data import db_connect

# Source ids are client UUIDs; validate before putting one in a filesystem path.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_PRINCIPAL_RE = re.compile(r"^(user:[0-9]{1,18})?$")
_UNIT_KEY_RE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
_MANIFEST_MAX_BYTES = 1_000_000

#: The view `assemble`'s SELECT reads the units through.
COUNTS_VIEW = "_concept_counts"
_EMPTY_COUNTS = (
    "SELECT NULL::VARCHAR AS dict_key, NULL::BIGINT AS concept_id,"
    " NULL::BIGINT AS record_count, NULL::BIGINT AS patient_count WHERE false"
)


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


def _run_dir(source_id: str, principal: str):
    p = cache_path(source_id, principal)
    return p.with_name(p.stem + ".run")


def _unit_files(source_id: str, principal: str) -> list:
    units = _run_dir(source_id, principal) / "units"
    return sorted(units.glob("*.parquet")) if units.is_dir() else []


def run_status(source_id: str, principal: str) -> dict | None:
    """The manifest of the last counting run, the keys of its units done, and
    when the last one was written — or None when no run was ever started."""
    manifest = _run_dir(source_id, principal) / "manifest.json"
    if not manifest.is_file():
        return None
    files = _unit_files(source_id, principal)
    return {
        "manifest": json.loads(manifest.read_text()),
        "done_units": [f.stem for f in files],
        "last_unit_at": max((f.stat().st_mtime for f in files), default=None),
    }


def write_manifest(source_id: str, principal: str, manifest: dict, reset: bool) -> None:
    """Store the client's run manifest; `reset` also drops every unit done, for a
    fresh run. The manifest is opaque here apart from its size."""
    body = json.dumps(manifest)
    if len(body) > _MANIFEST_MAX_BYTES:
        raise ValueError("the run manifest is too large")
    run = _run_dir(source_id, principal)
    if reset:
        shutil.rmtree(run, ignore_errors=True)
    run.mkdir(parents=True, exist_ok=True)
    tmp = run / f"manifest.json.tmp-{os.getpid()}-{uuid.uuid4().hex}"
    tmp.write_text(body)
    tmp.replace(run / "manifest.json")


def write_unit(
    config: dict,
    password: str | None,
    files: list[tuple[str, str]] | None,
    known: list[str] | None,
    select_sql: str,
    source_id: str,
    principal: str,
    key: str,
) -> None:
    """Run one counting unit against the source and keep its rows as the unit's
    file. Atomic, so a unit is either done or absent — never half there."""
    if not _UNIT_KEY_RE.match(key):
        raise ValueError(f"invalid unit key: {key!r}")
    run = _run_dir(source_id, principal)
    if not (run / "manifest.json").is_file():
        raise ValueError("no counting run started for this source")
    dest = run / "units" / f"{key}.parquet"
    db_connect.materialize_parquet(config, password, files, known, select_sql, str(dest))


def assemble(
    config: dict,
    password: str | None,
    files: list[tuple[str, str]] | None,
    known: list[str] | None,
    select_sql: str,
    source_id: str,
    principal: str,
) -> float:
    """Write the concept list from the units done so far: `select_sql` joins the
    dictionaries to the view `memory.main._concept_counts`, one row per unit row.
    Returns the new cache mtime."""
    unit_files = [f.as_posix() for f in _unit_files(source_id, principal)]
    if unit_files:
        paths = ", ".join("'" + db_connect._sql_path(p) + "'" for p in unit_files)
        view = f"SELECT * FROM read_parquet([{paths}], union_by_name = true)"
    else:
        view = _EMPTY_COUNTS
    dest = cache_path(source_id, principal)
    db_connect.materialize_parquet(
        config, password, files, known, select_sql, str(dest),
        views={COUNTS_VIEW: (view, unit_files)},
    )
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
            shutil.rmtree(_run_dir(source_id, principal), ignore_errors=True)
        return
    root = _cache_root()
    (root / f"{source_id}.parquet").unlink(missing_ok=True)
    shutil.rmtree(root / f"{source_id}.run", ignore_errors=True)
    for path in root.glob(f"{source_id}~*.parquet"):
        path.unlink(missing_ok=True)
    for path in root.glob(f"{source_id}~*.run"):
        shutil.rmtree(path, ignore_errors=True)
