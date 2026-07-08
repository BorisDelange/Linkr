"""Parse an uploaded CSV/Excel/Parquet blob into dataset columns + rows.

Runs on the backend (server mode) as the counterpart to the frontend's
papaparse/xlsx import. To stay in parity with the client:

- Columns get client-style ids ``col-<stamp>-<idx>`` and a type from our port of
  ``inferColumnType`` (type_inference.py).
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

from app.services.data.type_inference import infer_column_type, parse_boolean

_EXCEL_EXT = {".xlsx", ".xls"}


def _sql_str(value: str) -> str:
    """A single-quoted DuckDB string literal with embedded quotes doubled.

    `path` is server-derived, but `sheet`/`delimiter` come from client
    parse_options, so they must be escaped before going into a read_* call.
    """
    return "'" + value.replace("'", "''") + "'"


def _relation(con: duckdb.DuckDBPyConnection, path: Path, name: str, opts: dict):
    ext = Path(name).suffix.lower()
    p = str(path)
    header = opts.get("hasHeader", True)
    skip = int(opts.get("skipRows") or 0)

    if ext == ".parquet":
        return con.sql(f"SELECT * FROM read_parquet({_sql_str(p)})")

    if ext in _EXCEL_EXT:
        # A real .xlsx is a zip starting with "PK". Files renamed from CSV are a
        # common trap — give a clear message instead of DuckDB's "open zip" error.
        with open(p, "rb") as fh:
            if fh.read(2) != b"PK":
                raise ValueError(
                    f"'{name}' has an .xlsx extension but is not a valid Excel "
                    "file (it looks like a CSV or text file renamed to .xlsx). "
                    "Rename it to .csv and import again."
                )
        con.execute("INSTALL excel; LOAD excel;")
        sheet = opts.get("sheet")
        sheet_arg = f", sheet={_sql_str(sheet)}" if sheet else ""
        # all_varchar keeps our own type inference authoritative.
        return con.sql(
            f"SELECT * FROM read_xlsx({_sql_str(p)}{sheet_arg}, "
            f"header={str(header).lower()}, all_varchar=true)"
        )

    # CSV / TSV / TXT
    args = [_sql_str(p), "all_varchar=true", f"header={str(header).lower()}"]
    delim = opts.get("delimiter")
    if delim:
        args.append(f"delim={_sql_str(delim)}")
    if skip:
        args.append(f"skip={skip}")
    return con.sql(f"SELECT * FROM read_csv({', '.join(args)})")


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


def parse_blob(path: Path, file_name: str, parse_options: dict | None, stamp: int):
    """Return (columns, rows, row_count).

    columns: [{"id","name","type","order"}]  (id = col-<stamp>-<idx>)
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

    columns = [
        {
            "id": f"col-{stamp}-{idx}",
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
