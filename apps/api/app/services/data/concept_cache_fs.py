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

A run may also hold `stats-` units: the value statistics of every concept,
over id ranges packed from the record units (`plan_stats_ranges`). They are not
part of the list; `precomputed_stats` serves them to the detail panel.

A run is named by the `runId` of its manifest, and every unit names the run it
belongs to. A unit's COPY can take minutes, during which a reset or an
invalidation may replace the run: the unit is written under a temporary name and
only renamed into place if its run is still the current one, so a stale unit
never lands in a newer run (which a resume would take as done). One unit at a
time per run folder: a second live run is refused (`RunConflict`). The guard is
per process — the run-id check is what keeps the folder correct across workers.
"""

import contextlib
import json
import os
import re
import shutil
import threading
import uuid

import duckdb

from app.config import settings
from app.core.redact import redact_secrets
from app.services.data import db_connect

# Source ids are client UUIDs; validate before putting one in a filesystem path.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_PRINCIPAL_RE = re.compile(r"^(user:[0-9]{1,18})?$")
_UNIT_KEY_RE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
_RUN_ID_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")
_MANIFEST_MAX_BYTES = 1_000_000

#: The view `assemble`'s SELECT reads the units through.
COUNTS_VIEW = "_concept_counts"
#: Units the list is assembled from; `stats-` units are read by `precomputed_stats`.
_COUNT_UNIT_PREFIXES = ("records-", "patients-")
_STATS_UNIT_PREFIX = "stats-"
#: The tag `concept-count-plan.ts` gives these stats (PRECOMPUTED_STATS_VARIANT).
PRECOMPUTED_STATS_VARIANT = "p1p99-union-approx"
_STATS_BINS = 20
_EMPTY_COUNTS = (
    "SELECT NULL::VARCHAR AS dict_key, NULL::BIGINT AS concept_id,"
    " NULL::BIGINT AS record_count, NULL::BIGINT AS patient_count WHERE false"
)


class RunConflict(Exception):
    """The request belongs to a run that is no longer the current one, or would
    start a run while another one is counting."""


# Serialises every manifest write, unit rename and invalidation, and records the
# run folders with a unit in flight (run folder -> its run id).
_lock = threading.Lock()
_live: dict = {}


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


def _current_run_id(run) -> str | None:
    """The `runId` of the run folder's manifest; None without a manifest."""
    try:
        return json.loads((run / "manifest.json").read_text()).get("runId")
    except (FileNotFoundError, ValueError, AttributeError):
        return None


def _check_run_id(run_id) -> None:
    if run_id is not None and not (isinstance(run_id, str) and _RUN_ID_RE.match(run_id)):
        raise ValueError(f"invalid run id: {run_id!r}")


def _unit_files(source_id: str, principal: str) -> list:
    units = _run_dir(source_id, principal) / "units"
    return sorted(units.glob("*.parquet")) if units.is_dir() else []


def _paths_sql(files: list) -> str:
    return ", ".join("'" + db_connect._sql_path(f.as_posix()) + "'" for f in files)


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


def _complete_record_units(source_id: str, principal: str) -> list:
    """The record unit files of the event tables whose every record unit the
    manifest plans is done. An event table has one unit per concept column
    (`records-<i>-std`, `records-<i>-src`), and both name the same relation: with
    one alone, the concepts only the other column holds would read as absent."""
    try:
        manifest = json.loads((_run_dir(source_id, principal) / "manifest.json").read_text())
    except (FileNotFoundError, ValueError):
        return []
    units = manifest.get("units") if isinstance(manifest, dict) else None
    if not isinstance(units, list):
        return []
    planned: dict[str, set[str]] = {}
    for unit in units:
        key = unit.get("key") if isinstance(unit, dict) else None
        if isinstance(key, str) and key.startswith("records-"):
            planned.setdefault(key.rsplit("-", 1)[0], set()).add(key)
    done = {f.stem: f for f in _unit_files(source_id, principal)}
    return [
        done[key]
        for keys in planned.values() if keys <= done.keys()
        for key in sorted(keys)
    ]


# A unit's concept_id has whatever type its event table gives it: a DOUBLE
# (ids that went through pandas or a CSV) reads '54081624.0' as text, so a match
# on the text alone missed every concept of such a table. Matched as a number,
# and as text for the ids that are not one.
_SAME_ID = "(TRY_CAST(concept_id AS BIGINT) = TRY_CAST(? AS BIGINT) OR CAST(concept_id AS VARCHAR) = ?)"
_INTEGER_TYPES = {"TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT"}


def _same_id(con, paths: str, concept_id: int) -> tuple[str, list]:
    """The filter matching `concept_id` in the units at `paths`. On an integer
    column, a plain comparison, which the Parquet min/max statistics prune whole
    row groups with; the casts of `_SAME_ID` read every row."""
    kind = con.execute(
        f"DESCRIBE SELECT concept_id FROM read_parquet([{paths}], union_by_name = true)"
    ).fetchone()[1]
    if kind in _INTEGER_TYPES:
        return "concept_id = ?", [concept_id]
    return _SAME_ID, [str(concept_id)] * 2


_ID_IN = (
    "(TRY_CAST(concept_id AS BIGINT) IN (SELECT TRY_CAST(unnest(?::VARCHAR[]) AS BIGINT))"
    " OR CAST(concept_id AS VARCHAR) IN (SELECT unnest(?::VARCHAR[])))"
)


def counted_relations(source_id: str, principal: str, concept_ids: list[str]) -> list[dict]:
    """The event relations the record units of the last run counted — each with
    the signature of its SQL when counted and whether it holds any of
    `concept_ids` — so a query for those concepts can leave out the relations
    that hold none. Only an event table counted on every column it is planned
    for is reported; units of an older build name no relation and report none."""
    files = _complete_record_units(source_id, principal)
    if not files:
        return []
    paths = _paths_sql(files)
    con = db_connect._open()
    try:
        rows = con.execute(
            f"""SELECT relation, relation_sig,
                  bool_or({_ID_IN}) AS holds
                FROM read_parquet([{paths}], union_by_name = true)
                WHERE relation IS NOT NULL
                GROUP BY relation, relation_sig""",
            [concept_ids, concept_ids],
        ).fetchall()
    except duckdb.BinderException:
        return []
    finally:
        con.close()
    return [{"relation": r, "signature": sig, "holds": bool(holds)} for r, sig, holds in rows]


def write_manifest(source_id: str, principal: str, manifest: dict, reset: bool) -> None:
    """Store the client's run manifest; `reset` also drops every unit done, for a
    fresh run. The manifest is opaque here apart from its size and `runId`.

    Raises RunConflict when a unit of another run is being counted, or when a
    non-reset write names a run that is no longer the stored one."""
    body = json.dumps(manifest)
    if len(body) > _MANIFEST_MAX_BYTES:
        raise ValueError("the run manifest is too large")
    run_id = manifest.get("runId")
    _check_run_id(run_id)
    run = _run_dir(source_id, principal)
    with _lock:
        live = _live.get(run)
        if live is not None and (reset or live != run_id):
            raise RunConflict("a counting run is already in progress for this database")
        if not reset and run.is_dir() and _current_run_id(run) != run_id:
            raise RunConflict("this counting run was replaced")
        if reset:
            shutil.rmtree(run, ignore_errors=True)
        run.mkdir(parents=True, exist_ok=True)
        if live is None:
            # Temporary unit files left by a crashed worker.
            for leftover in (run / "units").glob("*.tmp-*"):
                leftover.unlink(missing_ok=True)
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
    run_id: str,
) -> None:
    """Run one counting unit of run `run_id` against the source and keep its
    rows as the unit's file. Atomic, so a unit is either done or absent — never
    half there — and kept only if `run_id` is still the current run."""
    if not _UNIT_KEY_RE.match(key):
        raise ValueError(f"invalid unit key: {key!r}")
    if not run_id:
        raise ValueError("a unit names its run")
    _check_run_id(run_id)
    run = _run_dir(source_id, principal)
    with _lock:
        if not (run / "manifest.json").is_file():
            raise RunConflict("no counting run started for this source")
        if _current_run_id(run) != run_id:
            raise RunConflict("this counting run was replaced")
        if run in _live:
            raise RunConflict("a counting run is already in progress for this database")
        _live[run] = run_id
    staged = run / "units" / f"{key}.parquet.tmp-{os.getpid()}-{uuid.uuid4().hex}"
    try:
        try:
            # A unit is the app's own aggregate: an external database computes it.
            db_connect.materialize_parquet(config, password, files, known, select_sql, str(staged), pushdown=True)
        except Exception as e:
            # An invalidation removing the folder mid-COPY fails the rename.
            if _current_run_id(run) != run_id:
                raise RunConflict("this counting run was replaced") from e
            raise
        with _lock:
            if _current_run_id(run) != run_id:
                raise RunConflict("this counting run was replaced")
            staged.replace(run / "units" / f"{key}.parquet")
    finally:
        staged.unlink(missing_ok=True)
        with _lock:
            _live.pop(run, None)


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
    unit_files = [f.as_posix() for f in _unit_files(source_id, principal) if f.stem.startswith(_COUNT_UNIT_PREFIXES)]
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


def pack_ranges(weights: list[tuple[int, int]], max_rows: int) -> list[tuple[int | None, int | None]]:
    """Cut ids into contiguous ranges of about `max_rows` rows each, from the rows
    of each id. An id never straddles two ranges — one heavier than `max_rows`
    gets a range of its own — and the outer bounds are open, so an id the counts
    did not see still falls in a range."""
    ranges: list[tuple[int | None, int | None]] = []
    lo: int | None = None
    total = 0
    last: int | None = None
    for concept_id, rows in sorted(weights):
        if total and total + rows > max_rows:
            ranges.append((lo, last))
            lo, total = last + 1, 0
        total += rows
        last = concept_id
    ranges.append((lo, None))
    return ranges


def plan_stats_ranges(source_id: str, principal: str, dicts: list[dict], max_rows: int) -> list[dict]:
    """The `stats` units of the run: per dictionary (`dictKey`, its value-bearing
    `relations`), the id ranges packed from what the record units counted in
    those relations. A dictionary none of whose relations the record units name
    (it holds its own counts, or they hold no row) is one unit of every id."""
    files = _complete_record_units(source_id, principal)
    weights: dict[str, list[tuple[int, int]]] = {}
    counted: set[str] = set()
    if files:
        con = db_connect._open()
        try:
            rows = con.execute(
                f"""SELECT dict_key, relation, TRY_CAST(concept_id AS BIGINT) AS cid, SUM(record_count)::BIGINT AS n
                    FROM read_parquet([{_paths_sql(files)}], union_by_name = true)
                    WHERE relation IS NOT NULL
                    GROUP BY dict_key, relation, cid"""
            ).fetchall()
        except duckdb.BinderException:
            rows = []
        finally:
            con.close()
        wanted = {(d["dictKey"], r) for d in dicts for r in d["relations"]}
        per_id: dict[tuple[str, int], int] = {}
        for dict_key, relation, cid, n in rows:
            counted.add(relation)
            if (dict_key, relation) in wanted and cid is not None:
                per_id[(dict_key, cid)] = per_id.get((dict_key, cid), 0) + int(n or 0)
        for (dict_key, cid), n in per_id.items():
            weights.setdefault(dict_key, []).append((cid, n))
    out: list[dict] = []
    for d in dicts:
        key = d["dictKey"]
        if not counted.intersection(d["relations"]):
            out.append({"dictKey": key, "lo": None, "hi": None})
        elif key in weights:
            out.extend({"dictKey": key, "lo": lo, "hi": hi} for lo, hi in pack_ranges(weights[key], max_rows))
    return out


def _stats_complete(source_id: str, principal: str, stats_files: list) -> bool:
    try:
        manifest = json.loads((_run_dir(source_id, principal) / "manifest.json").read_text())
    except (FileNotFoundError, ValueError):
        return False
    planned = {
        u.get("key") for u in manifest.get("units", [])
        if isinstance(u, dict) and str(u.get("key", "")).startswith(_STATS_UNIT_PREFIX)
    }
    return bool(planned) and planned <= {f.stem for f in stats_files}


def _r2(value):
    return None if value is None else round(float(value), 2)


def precomputed_stats(source_id: str, principal: str, concept_id: int, dict_key: str | None) -> tuple[dict, float] | None:
    """The detail-panel stats of one concept from the `stats` units, shaped as the
    panel's own query gives them (use-concepts.ts ConceptStats), with when they
    were computed — or None when no unit describes it. Once every stats unit is
    done, a concept without values is described too: its row count, no value."""
    stats_files = [f for f in _unit_files(source_id, principal) if f.stem.startswith(_STATS_UNIT_PREFIX)]
    if not stats_files:
        return None
    record_files = _complete_record_units(source_id, principal)
    con = db_connect._open()
    try:
        stats_paths = _paths_sql(stats_files)
        same_id, id_params = _same_id(con, stats_paths, concept_id)
        rows = con.execute(
            f"""SELECT dict_key, bin, bin_count, value_count, min_val, max_val, mean_val, std_val,
                       p01, q1_val, median_val, q3_val, p99
                FROM read_parquet([{stats_paths}], union_by_name = true)
                WHERE {same_id}""",
            id_params,
        ).fetchall()
        dict_keys = sorted({r[0] for r in rows})
        key = dict_key if dict_key is not None else (dict_keys[0] if dict_keys else None)
        rows = [r for r in rows if r[0] == key]
        if not rows and not _stats_complete(source_id, principal, stats_files):
            return None
        row_count = 0
        if record_files:
            record_paths = _paths_sql(record_files)
            same_id, id_params = _same_id(con, record_paths, concept_id)
            dict_filter = "" if key is None else "AND dict_key = ?"
            row_count = con.execute(
                f"""SELECT COALESCE(SUM(record_count), 0)::BIGINT
                    FROM read_parquet([{record_paths}], union_by_name = true)
                    WHERE {same_id} {dict_filter}""",
                id_params + ([] if key is None else [key]),
            ).fetchone()[0]
    finally:
        con.close()
    computed_at = max(f.stat().st_mtime for f in stats_files)
    stats: dict = {"rowCount": int(row_count), "histogramVariant": PRECOMPUTED_STATS_VARIANT}
    if not rows:
        stats["distribution"] = {
            "total_count": 0, "non_null_count": 0, "min_val": None, "max_val": None, "mean_val": None,
            "median_val": None, "std_val": None, "q1_val": None, "q3_val": None,
        }
        stats["histogram"] = []
        return stats, computed_at
    _, _, _, n, mn, mx, mean, std, p01, q1, median, q3, p99 = rows[0]
    stats["distribution"] = {
        "total_count": int(n), "non_null_count": int(n), "min_val": _r2(mn), "max_val": _r2(mx),
        "mean_val": _r2(mean), "median_val": _r2(median), "std_val": _r2(std), "q1_val": _r2(q1), "q3_val": _r2(q3),
    }
    excluded = sum(int(r[2]) for r in rows if r[1] == -1)
    width = None if p01 is None or p99 is None or p99 == p01 else (p99 - p01) / _STATS_BINS
    bins = sorted((r for r in rows if r[1] != -1), key=lambda r: (r[1] is None, r[1] or 0))
    stats["histogram"] = [
        {
            "bin_start": None if r[1] is None or width is None else _r2(r[1] * width + p01),
            "count": int(r[2]),
            "excluded_count": excluded,
        }
        for r in bins
    ]
    return stats, computed_at


def _shown_error(e: Exception) -> str:
    """The error text without the server's own folders, which its paths name."""
    text = redact_secrets(str(e)).replace(_cache_root().as_posix() + "/", "")
    return text.replace(settings.data_path.as_posix(), "<data>")


def diagnose_stats(source_id: str, principal: str, concept_id: int, dict_key: str | None) -> dict:
    """Why the `stats` step describes a concept or not, for the detail panel to
    say when it holds no value for one the database has values of: the range of
    ids that should cover it and what that unit wrote, where the concept shows
    up in the stats and record units — matched as text and as a number, since a
    type drift between the two is the first suspect — and the step overall."""
    run = _run_dir(source_id, principal)
    try:
        manifest = json.loads((run / "manifest.json").read_text())
    except (FileNotFoundError, ValueError):
        manifest = {}
    ranges = manifest.get("statsRanges") or [] if isinstance(manifest, dict) else []
    files = {f.stem: f for f in _unit_files(source_id, principal)}
    stats_files = [f for k, f in files.items() if k.startswith(_STATS_UNIT_PREFIX)]
    out: dict = {
        "conceptId": concept_id,
        "dictKey": dict_key,
        "statsUnitsPlanned": len(ranges),
        "statsUnitsDone": len(stats_files),
        "covering": [],
        "inStatsUnits": [],
        "inRecordUnits": [],
    }

    def covers(r: dict) -> bool:
        lo, hi = r.get("lo"), r.get("hi")
        return (dict_key is None or r.get("dictKey") == dict_key) and (lo is None or lo <= concept_id) and (hi is None or concept_id <= hi)

    con = db_connect._open()
    try:
        for i, r in enumerate(ranges):
            if not isinstance(r, dict) or not covers(r):
                continue
            key = f"{_STATS_UNIT_PREFIX}{i + 1}-of-{len(ranges)}"
            unit: dict = {"unit": key, "dictKey": r.get("dictKey"), "lo": r.get("lo"), "hi": r.get("hi"), "done": key in files}
            if key in files:
                rows, concepts, lo, hi, kind = con.execute(
                    f"""SELECT COUNT(*), COUNT(DISTINCT concept_id), MIN(TRY_CAST(concept_id AS BIGINT)),
                               MAX(TRY_CAST(concept_id AS BIGINT)), ANY_VALUE(typeof(concept_id))
                        FROM read_parquet('{db_connect._sql_path(files[key].as_posix())}')"""
                ).fetchone()
                unit.update(rows=rows, concepts=concepts, minConceptId=lo, maxConceptId=hi, conceptIdType=kind)
            out["covering"].append(unit)
        for label, chosen in (("inStatsUnits", stats_files), ("inRecordUnits", [f for k, f in files.items() if k.startswith("records-")])):
            for f in chosen:
                try:
                    hit = con.execute(
                        f"""SELECT COUNT(*) FILTER (WHERE CAST(concept_id AS VARCHAR) = ?),
                                   COUNT(*) FILTER (WHERE TRY_CAST(concept_id AS BIGINT) = ?),
                                   string_agg(DISTINCT dict_key, ', ') FILTER (WHERE TRY_CAST(concept_id AS BIGINT) = ?)
                            FROM read_parquet('{db_connect._sql_path(f.as_posix())}')""",
                        [str(concept_id), concept_id, concept_id],
                    ).fetchone()
                except duckdb.Error as e:
                    out[label].append({"unit": f.stem, "error": _shown_error(e)})
                    continue
                if hit[0] or hit[1]:
                    out[label].append({"unit": f.stem, "asText": hit[0], "asNumber": hit[1], "dictKeys": hit[2]})
        if stats_files:
            rows, concepts = con.execute(
                f"SELECT COUNT(*), COUNT(DISTINCT concept_id) FROM read_parquet([{_paths_sql(stats_files)}], union_by_name = true)"
            ).fetchone()
            out.update(statsRows=rows, statsConcepts=concepts)
    finally:
        con.close()
    return out


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
    with _lock:
        _invalidate(source_id, principal)


def _invalidate(source_id: str, principal: str | None) -> None:
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
