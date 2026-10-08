"""How well a Parquet table's layout serves lookups by one column.

Every patient widget reads `WHERE patient_id = …`. DuckDB skips the row groups
whose min/max statistics for that column exclude the value, so a table written
in patient order reads a handful of row groups for one patient, and the same
table in arrival order reads all of them — a full scan per widget. The metadata
alone tells which: no row is read.
"""

import duckdb

from app.services.data.db_connect import _sql_path, skip_glob_path


def _number(v: object) -> float | None:
    try:
        return float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def column_layout(paths: list[str], column: str) -> dict:
    """Row groups of `paths`, and the share of them a lookup of one value of
    `column` has to read: about 1/n when the files are sorted on it, about 1
    when they are not. The share is None when the statistics are missing or
    not numeric."""
    paths = [p for p in paths if not skip_glob_path(p)]
    if not paths:
        return {"row_groups": 0, "scan_fraction": None}
    files = ", ".join(f"'{_sql_path(p)}'" for p in paths)
    con = duckdb.connect()
    try:
        rows = con.execute(
            f"SELECT stats_min, stats_max FROM parquet_metadata([{files}]) WHERE lower(path_in_schema) = lower(?)",
            [column],
        ).fetchall()
    finally:
        con.close()
    bounds = [(_number(lo), _number(hi)) for lo, hi in rows]
    if not bounds or any(lo is None or hi is None for lo, hi in bounds):
        return {"row_groups": len(rows), "scan_fraction": None}
    lo = min(b[0] for b in bounds)
    hi = max(b[1] for b in bounds)
    span = hi - lo
    if span <= 0:
        return {"row_groups": len(rows), "scan_fraction": None}
    # A value drawn uniformly over [lo, hi] falls in a row group's range with
    # probability width / span; the mean is the share of row groups read.
    fraction = sum((b[1] - b[0]) / span for b in bounds) / len(bounds)
    return {"row_groups": len(rows), "scan_fraction": min(1.0, fraction)}
