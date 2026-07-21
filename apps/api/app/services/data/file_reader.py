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

import tempfile
from pathlib import Path

import duckdb

_EXCEL_EXT = {".xlsx", ".xls"}

# The dialog's encoding labels → the token DuckDB's CSV reader accepts. DuckDB
# 1.4 only knows utf-8 / latin-1 / utf-16 natively; Windows-1252 has no reader
# token, so it is decoded to UTF-8 in Python upstream (see `needs_python_decode`)
# and read here as utf-8.
_DUCKDB_ENCODING = {
    "UTF-8": "utf-8",
    "ISO-8859-1": "latin-1",
    "Windows-1252": "utf-8",
}

# Encodings DuckDB's read_csv cannot handle: the caller must transcode the blob
# to UTF-8 before building the read expression.
_PY_DECODE = {"Windows-1252": "cp1252"}


class ExcelSupportUnavailable(RuntimeError):
    """The `excel` DuckDB extension could not be installed/loaded (e.g. an
    offline server with no pre-warmed extension). Callers surface this as a
    clear message instead of a raw DuckDB error."""


def python_decode_codec(encoding: str | None) -> str | None:
    """Return the Python codec to transcode a CSV blob to UTF-8 when DuckDB's
    reader can't handle the dialog's chosen encoding, else None. Callers decode
    the raw bytes with this codec and re-encode UTF-8 before reading."""
    return _PY_DECODE.get(encoding or "")


def _transcode_to_utf8(path: str, codec: str) -> str:
    """Rewrite a CSV blob from `codec` to a UTF-8 temp file, returning its path.

    DuckDB's CSV reader has no Windows-1252 token (cp1252's 0x80–0x9F printables
    — curly quotes, €, … — would be mangled if read as latin-1), so the bytes are
    decoded in Python and re-encoded UTF-8 first. The temp file lives until the
    process cleans it up; it is only read synchronously during the same call."""
    with open(path, "rb") as fh:
        text = fh.read().decode(codec, errors="replace")
    tmp = tempfile.NamedTemporaryFile(
        prefix="linkr-transcode-", suffix=".csv", delete=False, mode="w",
        encoding="utf-8",
    )
    try:
        tmp.write(text)
    finally:
        tmp.close()
    return tmp.name


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
    encoding = opts.get("encoding")
    codec = python_decode_codec(encoding)
    if codec:
        # DuckDB can't read this encoding — transcode the blob to a UTF-8 temp and
        # read that instead (as utf-8, the reader default).
        path = _transcode_to_utf8(path, codec)
        encoding = "UTF-8"
    args = [_sql_str(path), "all_varchar=true", f"header={str(header).lower()}"]
    delim = opts.get("delimiter")
    if delim:
        args.append(f"delim={_sql_str(delim)}")
    if skip:
        args.append(f"skip={skip}")
    if nullstr is not None:
        args.append(f"nullstr={_sql_str(nullstr)}")
    # Only ever pass a DuckDB-supported token (utf-8 / latin-1); default utf-8.
    if encoding and encoding != "UTF-8":
        args.append(f"encoding={_sql_str(_DUCKDB_ENCODING.get(encoding, 'utf-8'))}")
    return f"read_csv({', '.join(args)})"
