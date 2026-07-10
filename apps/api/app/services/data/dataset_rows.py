"""Serialise dataset rows to Parquet (and back) for the blob store.

Rows are stored **columnar in Parquet**, not as a JSON blob, so the server can
paginate/sort/filter/aggregate with DuckDB without materialising the whole
dataset (see docs/planning/fullstack-storage-plan.html §04). This is the write
format for the ``data_sha`` blob; the original upload keeps its own format under
``raw_sha``.

Rows are dicts keyed by ``columnId`` (e.g. ``col-1728-0``), matching the parser
and what the frontend reads. Typing is driven by the dataset's ``columns`` — we
own the types (as the parser does), rather than letting DuckDB re-infer:

- number  → DOUBLE
- boolean → BOOLEAN
- date / string / unknown → VARCHAR  (preserves the exact string the parser
  produced; ``_coerce`` leaves dates as their original string, so we keep them
  as text to avoid any format drift)

Round-trip parity with the old JSON blob is preserved: values come back keyed by
columnId, dates/strings unchanged, null stays null (``7`` reads back as ``7.0``,
which is a no-op once the frontend coerces the column with ``Number()``).
"""

import json
import tempfile
from pathlib import Path
from typing import Any

import duckdb

_SQL_TYPE = {
    "number": "DOUBLE",
    "boolean": "BOOLEAN",
    "date": "VARCHAR",
    "string": "VARCHAR",
    "unknown": "VARCHAR",
}


def _columns_spec(columns: list[dict]) -> str:
    """DuckDB ``read_json(columns=...)`` struct entry list, keyed by columnId.

    Forcing the column set + types keeps our typing authoritative and pins the
    column order (so an all-null column doesn't get dropped by inference)."""
    parts = [
        f"{json.dumps(c['id'])}: '{_SQL_TYPE.get(c.get('type', 'string'), 'VARCHAR')}'"
        for c in columns
    ]
    return "{" + ", ".join(parts) + "}"


def _effective_columns(rows: list[dict], columns: list[dict]) -> list[dict]:
    """Columns to write. Falls back to the row keys (as VARCHAR) when the file
    has no declared columns yet — e.g. a manually-created file whose rows are
    written before any column metadata exists."""
    if columns:
        return columns
    seen: dict[str, None] = {}
    for row in rows:
        for key in row:
            seen.setdefault(key, None)
    return [{"id": key, "type": "string"} for key in seen]


def write_parquet(rows: list[dict], columns: list[dict], dir: Path | None = None) -> Path:
    """Write rows to a temp Parquet file (typed by ``columns``); return its path.

    Caller is expected to move it into the blob store (``blob_store.store_file``),
    which renames it to its content hash — so the temp name is throwaway.

    Pass ``dir`` to create the temp on a specific filesystem: the caller then
    does an atomic ``os.replace`` into that same dir, which fails cross-device
    (Errno 18) when the temp is on ``/tmp`` but the destination is a mounted
    volume (e.g. LINKR_DATA_DIR in Docker)."""
    columns = _effective_columns(rows, columns)
    if dir is not None:
        dir.mkdir(parents=True, exist_ok=True)
    tmp_dir = Path(tempfile.mkdtemp(prefix="linkr-rows-", dir=dir))
    json_path = tmp_dir / "rows.json"
    parquet_path = tmp_dir / "rows.parquet"
    json_path.write_text(json.dumps(rows), encoding="utf-8")

    con = duckdb.connect()
    try:
        if columns:
            source = f"SELECT * FROM read_json('{json_path.as_posix()}', columns={_columns_spec(columns)})"
        else:
            # No columns and no row keys — emit a valid empty Parquet.
            source = "SELECT NULL WHERE FALSE"
        con.execute(f"COPY ({source}) TO '{parquet_path.as_posix()}' (FORMAT PARQUET)")
    finally:
        con.close()
        json_path.unlink(missing_ok=True)
    return parquet_path


def read_parquet(path: Path, offset: int | None = None, limit: int | None = None) -> list[dict]:
    """Read rows back as dicts keyed by columnId. Optional LIMIT/OFFSET page."""
    con = duckdb.connect()
    try:
        sql = f"SELECT * FROM read_parquet('{path.as_posix()}')"
        if limit is not None:
            sql += f" LIMIT {int(limit)} OFFSET {int(offset or 0)}"
        res = con.execute(sql)
        names = [d[0] for d in res.description]
        return [_row_to_json(dict(zip(names, r))) for r in res.fetchall()]
    finally:
        con.close()


def _quote_ident(name: str) -> str:
    """Quote a column id as a DuckDB identifier (ids validated by the caller)."""
    return '"' + name.replace('"', '""') + '"'


def _build_where(
    filters: list[dict], na: list[dict], col_types: dict[str, str]
) -> tuple[str, list[Any]]:
    """Translate the UI's per-column filters + NA filters into a WHERE clause.

    Mirrors applyColumnFilter in ColumnFilterInput.tsx. Column ids are validated
    against ``col_types`` (unknown ids are ignored, never interpolated); values
    are bound as parameters."""
    clauses: list[str] = []
    params: list[Any] = []
    for f in filters:
        col = f.get("colId")
        if col not in col_types:
            continue
        ident = _quote_ident(col)
        ctype = col_types[col]
        if ctype == "number":
            if f.get("min") is not None:
                clauses.append(f"{ident} >= ?")
                params.append(f["min"])
            if f.get("max") is not None:
                clauses.append(f"{ident} <= ?")
                params.append(f["max"])
        elif ctype == "date":
            if f.get("from"):
                clauses.append(f"{ident} >= ?")
                params.append(f["from"])
            if f.get("to"):
                clauses.append(f"{ident} <= ?")
                params.append(f["to"])
        elif ctype == "boolean":
            val = f.get("value")
            if val in ("true", "false"):
                clauses.append(f"{ident} = ?")
                params.append(val == "true")
        else:  # string / unknown — case-insensitive substring
            term = f.get("value")
            if term:
                clauses.append(f"lower(CAST({ident} AS VARCHAR)) LIKE ?")
                params.append(f"%{str(term).lower()}%")

    for n in na:
        col = n.get("colId")
        if col not in col_types:
            continue
        ident = _quote_ident(col)
        if n.get("mode") == "exclude":
            clauses.append(f"{ident} IS NOT NULL")
        elif n.get("mode") == "only":
            clauses.append(f"{ident} IS NULL")

    if not clauses:
        return "", []
    return " WHERE " + " AND ".join(clauses), params


def query_page(
    path: Path,
    col_types: dict[str, str],
    *,
    offset: int = 0,
    limit: int = 100,
    sort: dict | None = None,
    filters: list[dict] | None = None,
    na: list[dict] | None = None,
) -> tuple[list[dict], int]:
    """Return (page_rows, total_count_after_filters) via DuckDB on the Parquet.

    This is the server counterpart to DatasetTable's client-side filter/sort/
    paginate — the page never materialises the whole dataset in the browser."""
    where, params = _build_where(filters or [], na or [], col_types)
    src = f"read_parquet('{path.as_posix()}')"
    con = duckdb.connect()
    try:
        total = con.execute(f"SELECT count(*) FROM {src}{where}", params).fetchone()[0]

        order = ""
        if sort and sort.get("colId") in col_types:
            direction = "DESC" if sort.get("dir") == "desc" else "ASC"
            # NULLs always sink to the bottom, matching the client sort.
            order = f" ORDER BY {_quote_ident(sort['colId'])} {direction} NULLS LAST"

        res = con.execute(
            f"SELECT * FROM {src}{where}{order} LIMIT {int(limit)} OFFSET {int(offset)}",
            params,
        )
        names = [d[0] for d in res.description]
        rows = [_row_to_json(dict(zip(names, r))) for r in res.fetchall()]
        return rows, int(total)
    finally:
        con.close()


_HISTOGRAM_BINS = 15
_MAX_CATEGORIES = 20


def _numeric_stats(con: duckdb.DuckDBPyConnection, src: str, ident: str) -> dict:
    row = con.execute(
        f"SELECT min({ident}), max({ident}), avg({ident}), median({ident}), "
        f"stddev_samp({ident}), quantile_cont({ident}, 0.25), "
        f"quantile_cont({ident}, 0.75) FROM {src} WHERE {ident} IS NOT NULL"
    ).fetchone()
    if row is None or row[0] is None:
        return {"kind": "numeric"}
    lo, hi, mean, median, std, q1, q3 = row
    out = {
        "kind": "numeric",
        "min": lo, "max": hi, "mean": mean, "median": median,
        "std": std, "q1": q1, "q3": q3, "iqr": (q3 - q1) if q1 is not None else None,
    }
    # Equal-width bins computed in SQL so only the counts cross the wire.
    if hi > lo:
        width = (hi - lo) / _HISTOGRAM_BINS
        rows = con.execute(
            f"SELECT least(floor(({ident} - {lo}) / {width}), {_HISTOGRAM_BINS - 1}) AS b, "
            f"count(*) AS n FROM {src} WHERE {ident} IS NOT NULL GROUP BY b ORDER BY b"
        ).fetchall()
        counts = {int(b): int(n) for b, n in rows}
        out["histogram"] = [
            {"lo": lo + i * width, "hi": lo + (i + 1) * width, "count": counts.get(i, 0)}
            for i in range(_HISTOGRAM_BINS)
        ]
    else:
        out["histogram"] = [{"lo": lo, "hi": hi, "count": None}]
    return out


def _date_stats(con: duckdb.DuckDBPyConnection, src: str, ident: str) -> dict:
    # Dates are stored as VARCHAR; cast to TIMESTAMP for min/max/bucketing.
    ts = f"try_cast({ident} AS TIMESTAMP)"
    row = con.execute(
        f"SELECT min({ts}), max({ts}), count({ts}) FROM {src}"
    ).fetchone()
    lo, hi, n = row
    out: dict[str, Any] = {"kind": "date", "min": None, "max": None, "timeline": []}
    if lo is None or n == 0:
        return out
    out["min"] = str(lo)
    out["max"] = str(hi)
    if hi > lo:
        span_us = (hi - lo).total_seconds() * 1_000_000
        width = span_us / _HISTOGRAM_BINS
        rows = con.execute(
            f"SELECT least(floor((epoch_us({ts}) - epoch_us(TIMESTAMP '{lo}')) / {width}), "
            f"{_HISTOGRAM_BINS - 1}) AS b, count(*) AS n FROM {src} "
            f"WHERE {ts} IS NOT NULL GROUP BY b ORDER BY b"
        ).fetchall()
        counts = {int(b): int(n) for b, n in rows}
        out["timeline"] = [
            {
                "lo": str(lo + _us_delta(i * width)),
                "count": counts.get(i, 0),
            }
            for i in range(_HISTOGRAM_BINS)
        ]
    else:
        out["timeline"] = [{"lo": str(lo), "count": int(n)}]
    return out


def _us_delta(microseconds: float):
    from datetime import timedelta

    return timedelta(microseconds=microseconds)


def _category_stats(con: duckdb.DuckDBPyConnection, src: str, ident: str) -> dict:
    distinct = int(
        con.execute(
            f"SELECT count(DISTINCT {ident}) FROM {src} WHERE {ident} IS NOT NULL"
        ).fetchone()[0]
    )
    rows = con.execute(
        f"SELECT CAST({ident} AS VARCHAR) AS v, count(*) AS n FROM {src} "
        f"WHERE {ident} IS NOT NULL GROUP BY v ORDER BY n DESC LIMIT {_MAX_CATEGORIES}"
    ).fetchall()
    return {
        "kind": "category",
        "items": [{"value": v, "count": int(n)} for v, n in rows],
        "totalCategories": distinct,
        "truncated": distinct > _MAX_CATEGORIES,
    }


def column_stats(path: Path, col_id: str, col_type: str) -> dict:
    """Aggregate stats for one column (server counterpart to ColumnStatsPanel).

    All binning/quantiles happen in DuckDB so the browser receives only summary
    scalars + ~15 histogram bins, never the raw values."""
    if not col_id:
        return {}
    ident = _quote_ident(col_id)
    src = f"read_parquet('{path.as_posix()}')"
    con = duckdb.connect()
    try:
        total, non_null, distinct = con.execute(
            f"SELECT count(*), count({ident}), count(DISTINCT {ident}) FROM {src}"
        ).fetchone()
        stats: dict[str, Any] = {
            "count": int(total),
            "nonNull": int(non_null),
            "nullCount": int(total) - int(non_null),
            "distinct": int(distinct),
        }
        if col_type == "number":
            stats.update(_numeric_stats(con, src, ident))
        elif col_type == "date":
            stats.update(_date_stats(con, src, ident))
        else:
            stats.update(_category_stats(con, src, ident))
        return stats
    finally:
        con.close()


def _row_to_json(row: dict[str, Any]) -> dict[str, Any]:
    """Coerce DuckDB scalars to JSON-serialisable values.

    Date/string columns are stored as VARCHAR so they already come back as
    strings; this guards any residual temporal/decimal types."""
    out: dict[str, Any] = {}
    for k, v in row.items():
        if v is None or isinstance(v, (str, int, float, bool)):
            out[k] = v
        else:
            out[k] = str(v)
    return out
