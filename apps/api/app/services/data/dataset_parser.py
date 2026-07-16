"""Parse an uploaded CSV/Excel/Parquet blob into dataset columns + rows.

Runs on the backend (server mode) as the counterpart to the frontend's
papaparse/xlsx import. To stay in parity with the client:

- Columns get deterministic name-derived ids ``col_<slug>`` (column_id.py, the twin
  of the frontend util) and a type from our port of ``inferColumnType``
  (type_inference.py). Same name → same id on client and server.
- Rows are keyed by **columnId** (not header name), matching what dashboards and
  analyses read via getFileRows.
- Cell values are coerced by inferred type to mirror papaparse ``dynamicTyping``:
  numbers → float/int, booleans → bool, everything else → the raw string (empty
  string → None).

DuckDB reads all columns as VARCHAR so *we* own the typing, rather than letting
DuckDB's own inference diverge from the frontend's.
"""

from pathlib import Path
from typing import Any

import duckdb

from app.services.data.column_id import build_column_ids
from app.services.data.file_reader import build_read_expr
from app.services.data.type_inference import infer_column_type, parse_boolean


def _relation(con: duckdb.DuckDBPyConnection, path: Path, name: str, opts: dict):
    # build_read_expr forces all_varchar so our own type inference stays
    # authoritative, and handles the CSV/Parquet/Excel dispatch + sheet option.
    return con.sql(f"SELECT * FROM {build_read_expr(con, str(path), name, opts)}")


def _coerce(value: Any, col_type: str) -> Any:
    if value is None:
        return None
    s = str(value)
    if s == "":
        return None
    if col_type == "number":
        try:
            f = float(s)
            return int(f) if f.is_integer() else f
        except ValueError:
            return s
    if col_type == "boolean":
        b = parse_boolean(s)
        return b if b is not None else s
    return s


def parse_blob(path: Path, file_name: str, parse_options: dict | None):
    """Return (columns, rows, row_count).

    columns: [{"id","name","type","order"}]  (id = col_<slug>, derived from name)
    rows:    list of {columnId: value}
    """
    opts = parse_options or {}
    con = duckdb.connect()
    try:
        rel = _relation(con, path, file_name, opts)
        headers = list(rel.columns)
        raw_rows = rel.fetchall()  # list of tuples, VARCHAR cells
    finally:
        con.close()

    # Per-column raw values for type inference.
    by_col_raw: list[list[Any]] = [[] for _ in headers]
    for row in raw_rows:
        for i in range(len(headers)):
            by_col_raw[i].append(row[i] if i < len(row) else None)

    ids = build_column_ids(headers)
    columns = [
        {
            "id": ids[idx],
            "name": name,
            "type": infer_column_type(by_col_raw[idx]),
            "order": idx,
        }
        for idx, name in enumerate(headers)
    ]

    rows: list[dict[str, Any]] = []
    for row in raw_rows:
        obj: dict[str, Any] = {}
        for idx, col in enumerate(columns):
            obj[col["id"]] = _coerce(row[idx] if idx < len(row) else None, col["type"])
        rows.append(obj)

    return columns, rows, len(rows)
