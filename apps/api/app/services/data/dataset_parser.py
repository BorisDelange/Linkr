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

import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any

import duckdb

from app.services.data.column_id import build_column_ids
from app.services.data.file_reader import build_read_expr, cleanup_transcoded, is_excel
from app.services.data.type_inference import (
    BOOL_FALSE,
    BOOL_TRUE,
    infer_column_type,
    normalize_na_values,
    parse_boolean,
)

# Preview reads a bounded slice of rows; the full parse still scans everything.
PREVIEW_ROWS = 50

# Derived from type_inference (the source of truth) so the SQL-based preview
# inference can't drift from the row-by-row parse used at import.
_BOOL_TOKENS = sorted(BOOL_TRUE | BOOL_FALSE)
# DuckDB (RE2) form of DATE_DATETIME_RE, unanchored (regexp_full_match anchors).
_DATE_RE_SQL = (
    r"\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:?\d{2}|Z)?)?"
)


def _relation(con: duckdb.DuckDBPyConnection, path: Path, name: str, opts: dict):
    # build_read_expr forces all_varchar so our own type inference stays
    # authoritative, and handles the CSV/Parquet/Excel dispatch + sheet option.
    return con.sql(f"SELECT * FROM {build_read_expr(con, str(path), name, opts)}")


def _coerce(value: Any, col_type: str, na_set: set[str] | None = None) -> Any:
    if value is None:
        return None
    s = str(value)
    if s == "":
        return None
    # An NA token is missing data, whatever the column's type.
    if na_set and s.strip().lower() in na_set:
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


_VALID_TYPES = {"string", "number", "boolean", "date"}


def _typed(inferred: str, col_id: str, overrides: dict | None) -> str:
    """The column's effective type: a valid user override wins over inference."""
    forced = (overrides or {}).get(col_id)
    return forced if forced in _VALID_TYPES else inferred


def _columns_from(
    headers: list[str],
    by_col_raw: list[list[Any]],
    overrides: dict | None = None,
    na_values: list[str] | None = None,
) -> list[dict]:
    ids = build_column_ids(headers)
    return [
        {
            "id": ids[idx],
            "name": name,
            "type": _typed(
                infer_column_type(by_col_raw[idx], na_values), ids[idx], overrides
            ),
            "order": idx,
        }
        for idx, name in enumerate(headers)
    ]


def _rows_from(
    raw_rows: list[tuple], columns: list[dict], na_values: list[str] | None = None
) -> list[dict[str, Any]]:
    na_set = normalize_na_values(na_values)
    rows: list[dict[str, Any]] = []
    for row in raw_rows:
        obj: dict[str, Any] = {}
        for idx, col in enumerate(columns):
            obj[col["id"]] = _coerce(
                row[idx] if idx < len(row) else None, col["type"], na_set
            )
        rows.append(obj)
    return rows


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
        cleanup_transcoded(con)
        con.close()

    # Per-column raw values for type inference (scans the whole column).
    by_col_raw: list[list[Any]] = [[] for _ in headers]
    for row in raw_rows:
        for i in range(len(headers)):
            by_col_raw[i].append(row[i] if i < len(row) else None)

    na_values = opts.get("naValues")
    columns = _columns_from(headers, by_col_raw, opts.get("columnTypes"), na_values)
    return columns, _rows_from(raw_rows, columns, na_values), len(raw_rows)


def _our_type_for_duckdb(duckdb_type: str) -> str:
    """Map a DuckDB column type (from DESCRIBE) to our 4 canonical types. Used only
    for native-parquet listing, where the file already carries real types — so we
    trust them instead of scanning every value in Python."""
    t = duckdb_type.upper()
    if t.startswith(("TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT",
                     "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT",
                     "DECIMAL", "NUMERIC", "REAL", "FLOAT", "DOUBLE")):
        return "number"
    if t.startswith("BOOLEAN"):
        return "boolean"
    if t.startswith(("DATE", "TIMESTAMP", "TIME")):
        return "date"
    return "string"


def parquet_schema(path: Path) -> tuple[list[dict], int]:
    """Columns + row count of a native .parquet WITHOUT materializing any rows.

    DuckDB reads the schema and the footer's row count from metadata, so this is
    near-instant even on multi-GB files — unlike parse_blob, which fetchall()s
    every row. Column ids/types match parse_blob's shape (id = col_<slug>, one of
    the 4 canonical types). Used by the dataset listing / cache-meta path."""
    con = duckdb.connect()
    try:
        expr = f"read_parquet({_sql_str(str(path))})"
        described = con.execute(f"DESCRIBE SELECT * FROM {expr}").fetchall()
        row_count = con.execute(f"SELECT COUNT(*) FROM {expr}").fetchone()[0]
    finally:
        con.close()
    headers = [d[0] for d in described]
    ids = build_column_ids(headers)
    columns = [
        {"id": ids[idx], "name": name, "type": _our_type_for_duckdb(described[idx][1]), "order": idx}
        for idx, name in enumerate(headers)
    ]
    return columns, int(row_count)


def _sql_str(value: str) -> str:
    """Single-quote a string literal for DuckDB (doubling embedded quotes)."""
    return "'" + value.replace("'", "''") + "'"


def excel_sheet_names(path: Path) -> list[str]:
    """Sheet names of an .xlsx, read from the zip's workbook.xml without loading
    the whole workbook. Returns [] if the file isn't a readable xlsx zip."""
    try:
        with zipfile.ZipFile(path) as zf:
            with zf.open("xl/workbook.xml") as fh:
                tree = ET.parse(fh)
    except (zipfile.BadZipFile, KeyError, ET.ParseError, OSError):
        return []
    # The <sheet> elements live under <sheets>; the tag carries the spreadsheetml
    # namespace, so match on the local name rather than a fixed prefix.
    names: list[str] = []
    for el in tree.iter():
        if el.tag.rsplit("}", 1)[-1] == "sheet":
            name = el.get("name")
            if name:
                names.append(name)
    return names


def preview_blob(path: Path, file_name: str, parse_options: dict | None) -> dict:
    """Parse a blob for the import dialog's preview WITHOUT persisting anything.

    Types are inferred over the WHOLE column (a single DuckDB aggregate pass, no
    Python materialization) so the preview shows exactly the types the eventual
    import will store; only ``PREVIEW_ROWS`` rows are materialized for display.
    For Excel, the workbook's sheet names are returned so the dialog can populate
    its sheet selector without a browser parse.

    Returns {columns, preview, rowCount, sheetNames?}."""
    opts = parse_options or {}
    con = duckdb.connect()
    try:
        reader = build_read_expr(con, str(path), file_name, opts)
        rel = con.sql(f"SELECT * FROM {reader}")
        headers = list(rel.columns)
        row_count = con.sql(f"SELECT count(*) FROM {reader}").fetchone()[0]
        types = _infer_types_sql(con, reader, headers, opts.get("naValues"))
        preview_raw = con.sql(
            f"SELECT * FROM {reader} LIMIT {PREVIEW_ROWS}"
        ).fetchall()
    finally:
        cleanup_transcoded(con)
        con.close()

    ids = build_column_ids(headers)
    overrides = opts.get("columnTypes")
    columns = [
        {"id": ids[idx], "name": name, "type": _typed(types[idx], ids[idx], overrides), "order": idx}
        for idx, name in enumerate(headers)
    ]
    result: dict[str, Any] = {
        "columns": columns,
        "preview": _rows_from(preview_raw, columns, opts.get("naValues")),
        "rowCount": int(row_count),
    }
    if is_excel(file_name):
        result["sheetNames"] = excel_sheet_names(path)
    return result


def _quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _infer_types_sql(
    con: duckdb.DuckDBPyConnection,
    reader: str,
    headers: list[str],
    na_values: list[str] | None = None,
) -> list[str]:
    """Infer each column's type over the whole file with one aggregate query,
    mirroring ``infer_column_type``'s priority (boolean > number > date > string)
    and its token/date semantics, but in SQL so no rows are materialized.

    A column is a type iff EVERY present value satisfies it. Empty string and NA
    tokens count as null (matching the Python coercion)."""
    if not headers:
        return []
    bool_tokens = ", ".join(f"'{t}'" for t in _BOOL_TOKENS)
    na_set = normalize_na_values(na_values)
    parts = []
    for i, _name in enumerate(headers):
        c = _quote_ident(f"col{i}")
        # Strip the SAME whitespace the row-by-row parser does: Python str.strip()
        # trims tab/newline/CR too, but DuckDB's one-arg trim() strips only spaces
        # — so a "\ttrue" cell would infer boolean at import but string in preview.
        # Build the ASCII-whitespace set via chr() so the SQL stays readable.
        tc = f"trim({c}, ' ' || chr(9) || chr(10) || chr(13) || chr(11) || chr(12))"
        # "Present" must match is_missing_value: non-empty AND not an NA token.
        if na_set:
            na_list = ", ".join(_sql_str(t) for t in sorted(na_set))
            present = f"{tc} <> '' AND lower({tc}) NOT IN ({na_list})"
        else:
            present = f"{tc} <> ''"
        # present count and per-type "all match" counts.
        parts.append(f"count({c}) FILTER (WHERE {present}) AS n_{i}")
        parts.append(
            f"count(*) FILTER (WHERE {present} AND "
            f"try_cast({tc} AS DOUBLE) IS NOT NULL) AS num_{i}"
        )
        parts.append(
            f"count(*) FILTER (WHERE {present} AND "
            f"lower({tc}) IN ({bool_tokens})) AS bool_{i}"
        )
        parts.append(
            f"count(*) FILTER (WHERE {present} AND "
            f"regexp_full_match({tc}, '{_DATE_RE_SQL}')) AS date_{i}"
        )
    aliased = ", ".join(f"{_quote_ident(h)} AS {_quote_ident(f'col{i}')}"
                        for i, h in enumerate(headers))
    row = con.sql(
        f"SELECT {', '.join(parts)} FROM (SELECT {aliased} FROM {reader})"
    ).fetchone()

    types: list[str] = []
    for i in range(len(headers)):
        n, num, bl, dt = row[i * 4], row[i * 4 + 1], row[i * 4 + 2], row[i * 4 + 3]
        if n == 0:
            types.append("unknown")
        elif bl == n:
            types.append("boolean")
        elif num == n:
            types.append("number")
        elif dt == n:
            types.append("date")
        else:
            types.append("string")
    return types
