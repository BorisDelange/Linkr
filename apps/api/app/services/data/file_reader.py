"""Build the DuckDB read expression for an uploaded CSV/Excel/Parquet blob.

Single source of truth for "how do we read a raw file source server-side",
shared by the two server-mode importers that both mirror the browser's
papaparse/xlsx/DuckDB-WASM parse:

- dataset import (`dataset_parser.parse_blob`) — materializes columns + rows.
- concept-mapping file source (`db_connect.query_file_source`) — wraps the
  expression in the `source_concepts` view the frontend's SQL references.

The blob store keys files by content hash (no extension on disk), so the reader
is chosen from the original `file_name`'s extension. Excel needs DuckDB's
`excel` extension; the caller passes a connection so the INSTALL/LOAD is cached
under the shared extension directory.
"""

from pathlib import Path

import duckdb

_EXCEL_EXT = {".xlsx", ".xls"}


class ExcelSupportUnavailable(RuntimeError):
    """The `excel` DuckDB extension could not be installed/loaded (e.g. an
    offline server with no pre-warmed extension). Callers surface this as a
    clear message instead of a raw DuckDB error."""


def _sql_str(value: str) -> str:
    """A single-quoted DuckDB string literal with embedded quotes doubled.

    `path` is server-derived, but `sheet`/`delimiter` come from client
    parse_options, so they must be escaped before going into a read_* call."""
    return "'" + value.replace("'", "''") + "'"


def is_excel(file_name: str | None) -> bool:
    return Path(file_name or "").suffix.lower() in _EXCEL_EXT


def build_read_expr(
    con: duckdb.DuckDBPyConnection,
    path: str,
    file_name: str | None,
    opts: dict,
    *,
    nullstr: str | None = None,
) -> str:
    """Return a DuckDB table expression (``read_csv(...)`` / ``read_parquet(...)``
    / ``read_xlsx(...)``) for the file at `path`, using its extension and the
    client `parse_options`. `all_varchar` is forced so the frontend / our own
    type inference stays authoritative rather than DuckDB's. For Excel, INSTALLs
    and LOADs the `excel` extension on `con` first.

    `nullstr` (CSV only) mirrors the browser's DuckDB-WASM mount for the
    concept-mapping file source, which reads with ``nullstr='NA'`` so a literal
    "NA" cell becomes NULL identically server-side."""
    ext = Path(file_name or "").suffix.lower()
    header = opts.get("hasHeader", True)
    skip = int(opts.get("skipRows") or 0)

    if ext in (".parquet", ".pq"):
        return f"read_parquet({_sql_str(path)})"

    if ext in _EXCEL_EXT:
        # A real .xlsx is a zip starting with "PK". Files renamed from CSV are a
        # common trap — give a clear message instead of DuckDB's "open zip" error.
        with open(path, "rb") as fh:
            if fh.read(2) != b"PK":
                raise ValueError(
                    f"'{file_name}' has an .xlsx extension but is not a valid "
                    "Excel file (it looks like a CSV or text file renamed to "
                    ".xlsx). Rename it to .csv and import again."
                )
        try:
            con.execute("INSTALL excel; LOAD excel;")
        except duckdb.Error as e:
            raise ExcelSupportUnavailable(str(e)) from e
        sheet = opts.get("sheet")
        sheet_arg = f", sheet={_sql_str(sheet)}" if sheet else ""
        return (
            f"read_xlsx({_sql_str(path)}{sheet_arg}, "
            f"header={str(header).lower()}, all_varchar=true)"
        )

    # CSV / TSV / TXT
    args = [_sql_str(path), "all_varchar=true", f"header={str(header).lower()}"]
    delim = opts.get("delimiter")
    if delim:
        args.append(f"delim={_sql_str(delim)}")
    if skip:
        args.append(f"skip={skip}")
    if nullstr is not None:
        args.append(f"nullstr={_sql_str(nullstr)}")
    return f"read_csv({', '.join(args)})"
