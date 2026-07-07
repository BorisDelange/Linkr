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


def write_parquet(rows: list[dict], columns: list[dict]) -> Path:
    """Write rows to a temp Parquet file (typed by ``columns``); return its path.

    Caller is expected to move it into the blob store (``blob_store.store_file``),
    which renames it to its content hash — so the temp name is throwaway."""
    columns = _effective_columns(rows, columns)
    tmp_dir = Path(tempfile.mkdtemp(prefix="linkr-rows-"))
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
