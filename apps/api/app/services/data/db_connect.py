"""Server-side connection to external SQL databases (PostgreSQL, MySQL).

Uses DuckDB's ``postgres`` / ``mysql`` extensions to ATTACH a live database
read-only, introspect its schema and run SQL — the same DuckDB SQL dialect the
whole app already speaks, so no per-engine query rewriting and no extra hard
dependency (DuckDB is already required). The password is passed in per call and
never stored: it lives only for the duration of the connection.
"""

import datetime
import re
from decimal import Decimal

import duckdb

from app.config import settings

_ATTACH_ALIAS = "ext"

# Safety cap on rows returned to the browser. The UI paginates/displays far less;
# an uncapped SELECT * on a huge table would otherwise overwhelm the response.
MAX_QUERY_ROWS = 10_000

# Per-engine wiring: the DuckDB extension, the ATTACH TYPE, and the passthrough
# query function used to read the source's own information_schema.
_ENGINES = {
    "postgresql": {"extension": "postgres", "type": "postgres", "query_fn": "postgres_query"},
    "mysql": {"extension": "mysql", "type": "mysql", "query_fn": "mysql_query"},
}


def _engine_spec(config: dict) -> dict:
    engine = config.get("engine")
    spec = _ENGINES.get(engine)
    if spec is None:
        raise ValueError(f"unsupported engine for server-side connection: {engine}")
    return spec


def _ext_dir() -> str:
    d = settings.data_path / "_duckdb_ext"
    d.mkdir(parents=True, exist_ok=True)
    return d.as_posix()


def _connect(extension: str) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    # Persist installed extensions under data_dir so INSTALL only hits the
    # network once (and can be pre-warmed at build time in an offline image).
    con.execute(f"SET extension_directory = '{_ext_dir()}'")
    con.execute(f"INSTALL {extension}")
    con.execute(f"LOAD {extension}")
    return con


def _dsn(config: dict, password: str | None) -> str:
    """Build a key=value DSN. Both the libpq (Postgres) and MySQL ATTACH strings
    accept host/port/user/password; the database key differs (dbname vs database)."""
    is_mysql = config.get("engine") == "mysql"
    parts: list[str] = []
    if host := config.get("host"):
        parts.append(f"host={host}")
    if port := config.get("port"):
        parts.append(f"port={int(port)}")
    if database := config.get("database"):
        parts.append(f"{'database' if is_mysql else 'dbname'}={database}")
    if username := config.get("username"):
        parts.append(f"user={username}")
    if password:
        parts.append(f"password={password}")
    return " ".join(parts)


def _scope(config: dict) -> str:
    """The schema (Postgres) or database (MySQL) whose tables we expose. Validated
    as a plain identifier since it is interpolated into SQL below."""
    is_mysql = config.get("engine") == "mysql"
    scope = config.get("schema") or config.get("database") if is_mysql else config.get("schema")
    scope = scope or ("mysql" if is_mysql else "public")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", scope):
        raise ValueError(f"invalid schema/database name: {scope!r}")
    return scope


def _attach(con: duckdb.DuckDBPyConnection, config: dict, password: str | None) -> None:
    spec = _engine_spec(config)
    dsn = _dsn(config, password)
    con.execute(f"ATTACH '{dsn}' AS {_ATTACH_ALIAS} (TYPE {spec['type']}, READ_ONLY)")


def _row_to_json(row: dict) -> dict:
    out: dict = {}
    for k, v in row.items():
        if isinstance(v, (datetime.date, datetime.datetime)):
            out[k] = v.isoformat()
        elif isinstance(v, Decimal):
            out[k] = float(v)
        else:
            out[k] = v
    return out


def _split_statements(sql: str) -> list[str]:
    """Split SQL on semicolons, ignoring those inside single-quoted strings and
    line comments. Mirrors the frontend's splitSqlStatements so multi-statement
    scripts (CREATE VIEW …; SELECT …;) behave the same server-side."""
    stmts: list[str] = []
    current = ""
    i = 0
    n = len(sql)
    while i < n:
        ch = sql[i]
        if ch == "'":
            current += ch
            i += 1
            while i < n:
                if sql[i] == "'" and i + 1 < n and sql[i + 1] == "'":
                    current += "''"
                    i += 2
                elif sql[i] == "'":
                    current += "'"
                    i += 1
                    break
                else:
                    current += sql[i]
                    i += 1
        elif ch == "-" and i + 1 < n and sql[i + 1] == "-":
            nl = sql.find("\n", i)
            i = n if nl == -1 else nl + 1
        elif ch == ";":
            if current.strip():
                stmts.append(current.strip())
            current = ""
            i += 1
        else:
            current += ch
            i += 1
    if current.strip():
        stmts.append(current.strip())
    return stmts


def _run_statements(
    con: duckdb.DuckDBPyConnection, search_path: str, sql: str
) -> list[dict]:
    """Execute each statement in `sql` sequentially, returning the last result's
    rows. `search_path` puts DuckDB's writable `memory` catalog first (so CREATE
    VIEW / temp tables land there) then the read-only attached source for reads."""
    con.execute(f"SET search_path='{search_path}'")
    result: duckdb.DuckDBPyConnection | None = None
    for stmt in _split_statements(sql):
        result = con.execute(stmt)
    if result is None or result.description is None:
        return []
    names = [d[0] for d in result.description]
    # Cap the payload: a `SELECT *` on a billion-row table would otherwise stream
    # everything back and blow up the response. Fetch one more than the cap so
    # callers could detect truncation if needed; we just cut to MAX_QUERY_ROWS.
    rows = result.fetchmany(MAX_QUERY_ROWS)
    return [_row_to_json(dict(zip(names, row))) for row in rows]


def query_external(config: dict, password: str | None, sql: str) -> list[dict]:
    """Run SQL against the attached source and return rows as dicts.

    Bare table names (``FROM patients``) resolve to the source via search_path,
    matching the DuckDB-WASM path. The source is attached read-only; CREATE VIEW
    / temp tables land in DuckDB's local `memory` catalog (writable), so
    multi-statement scripts work. Date/time values come back as ISO strings.
    """
    spec = _engine_spec(config)
    scope = _scope(config)
    con = _connect(spec["extension"])
    try:
        _attach(con, config, password)
        return _run_statements(con, f"memory,{_ATTACH_ALIAS}.{scope}", sql)
    finally:
        con.close()


def _attach_file(con: duckdb.DuckDBPyConnection, engine: str, path: str) -> None:
    """ATTACH a local database file read-only. DuckDB files attach natively;
    SQLite needs the sqlite extension."""
    if engine == "sqlite":
        con.execute("INSTALL sqlite")
        con.execute("LOAD sqlite")
        con.execute(f"ATTACH '{path}' AS {_ATTACH_ALIAS} (TYPE sqlite, READ_ONLY)")
    else:  # duckdb
        con.execute(f"ATTACH '{path}' AS {_ATTACH_ALIAS} (READ_ONLY)")


def query_file(engine: str, path: str, sql: str) -> list[dict]:
    """Run SQL against a local DuckDB/SQLite file (server-side). Read-only file;
    CREATE VIEW / temp tables land in the writable `memory` catalog."""
    con = duckdb.connect()
    con.execute(f"SET extension_directory = '{_ext_dir()}'")
    try:
        _attach_file(con, engine, path)
        return _run_statements(con, f"memory,{_ATTACH_ALIAS}", sql)
    finally:
        con.close()


def query_csv(path: str, select_sql: str, sql: str) -> list[dict]:
    """Run SQL over a CSV blob for a mapping project's file source.

    `select_sql` is the column-normalizing projection (built from the project's
    columnMapping, mirroring the DuckDB-WASM mount) that becomes the view
    ``source_concepts`` — the table name the frontend's SQL references. The CSV
    is read with ``read_csv_auto(..., nullstr='NA')`` to match the browser path.
    """
    con = duckdb.connect()
    con.execute(f"SET extension_directory = '{_ext_dir()}'")
    try:
        con.execute(
            f"CREATE VIEW source_concepts AS SELECT {select_sql} "
            f"FROM read_csv_auto('{path}', nullstr='NA')"
        )
        return _run_statements(con, "memory", sql)
    finally:
        con.close()


def introspect_file(engine: str, path: str) -> list[dict]:
    """Tables + columns of a local DuckDB/SQLite file. Types are DuckDB-normalized
    (the file has no separate native catalog to passthrough to)."""
    con = duckdb.connect()
    con.execute(f"SET extension_directory = '{_ext_dir()}'")
    try:
        _attach_file(con, engine, path)
        rows = con.execute(
            "SELECT table_name, column_name, data_type, is_nullable "
            "FROM information_schema.columns "
            f"WHERE table_catalog = '{_ATTACH_ALIAS}' "
            "ORDER BY table_name, ordinal_position"
        ).fetchall()
    finally:
        con.close()

    tables: dict[str, list[dict]] = {}
    for table_name, column_name, data_type, is_nullable in rows:
        tables.setdefault(str(table_name), []).append(
            {
                "name": str(column_name),
                "type": str(data_type),
                "nullable": str(is_nullable).upper() == "YES",
            }
        )
    return [{"name": name, "columns": cols} for name, cols in tables.items()]


def _table_of(file_name: str, known: list[str]) -> str:
    """Table name for a Parquet file, mirroring the frontend's extractTableName:
    prefer a known-table segment, else the parent dir, else the file stem."""
    parts = [p for p in file_name.replace("\\", "/").split("/") if p]
    known_set = {k.lower() for k in known}
    if known_set:
        for seg in reversed(parts):
            stem = re.sub(r"\.[^.]+$", "", seg).lower()
            if stem in known_set:
                return stem
    if len(parts) >= 2:
        return parts[-2].lower()
    return re.sub(r"\.[^.]+$", "", parts[-1]).lower()


def _group_parquet(files: list[tuple[str, str]], known: list[str]) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {}
    for file_name, path in files:
        if not file_name.lower().endswith((".parquet", ".pq")):
            continue
        groups.setdefault(_table_of(file_name, known), []).append(path)
    return groups


def _reader(paths: list[str]) -> str:
    if len(paths) == 1:
        return f"read_parquet('{paths[0]}')"
    lst = ", ".join(f"'{p}'" for p in paths)
    return f"read_parquet([{lst}])"


def _attach_parquet_views(
    con: duckdb.DuckDBPyConnection, groups: dict[str, list[str]]
) -> None:
    con.execute(f"CREATE SCHEMA IF NOT EXISTS {_ATTACH_ALIAS}")
    for table, paths in groups.items():
        con.execute(
            f'CREATE VIEW {_ATTACH_ALIAS}."{table}" AS SELECT * FROM {_reader(paths)}'
        )


def query_parquet_folder(
    files: list[tuple[str, str]], known: list[str], sql: str
) -> list[dict]:
    """Run read-only SQL against a folder of Parquet files exposed as views, one
    per table (mirrors the browser mountFileFolder path)."""
    groups = _group_parquet(files, known)
    con = duckdb.connect()
    con.execute(f"SET extension_directory = '{_ext_dir()}'")
    try:
        _attach_parquet_views(con, groups)
        return _run_statements(con, f"{_ATTACH_ALIAS},memory", sql)
    finally:
        con.close()


def introspect_parquet_folder(
    files: list[tuple[str, str]], known: list[str]
) -> list[dict]:
    """Tables + columns for a folder of Parquet files (one table per group)."""
    groups = _group_parquet(files, known)
    con = duckdb.connect()
    con.execute(f"SET extension_directory = '{_ext_dir()}'")
    result: list[dict] = []
    try:
        for table, paths in groups.items():
            cols = con.execute(f"DESCRIBE SELECT * FROM {_reader(paths)}").fetchall()
            result.append(
                {
                    "name": table,
                    "columns": [
                        {"name": str(c[0]), "type": str(c[1]), "nullable": True}
                        for c in cols
                    ],
                }
            )
    finally:
        con.close()
    return result


def introspect_external(config: dict, password: str | None) -> list[dict]:
    """ATTACH the source read-only and return its tables + columns.

    Shape mirrors the frontend's IntrospectedTable[]:
        [{ "name": str, "columns": [{ "name", "type", "nullable" }] }]
    Reads the source's own information_schema via the engine's passthrough query
    function so column types come back as native names (integer, text, date).
    Raises on connection/permission failure — the caller turns it into a result.
    """
    spec = _engine_spec(config)
    scope = _scope(config)
    con = _connect(spec["extension"])
    try:
        _attach(con, config, password)
        # Single-quotes doubled for the nested SQL literal; `scope` is validated.
        inner = (
            "SELECT table_name, column_name, data_type, is_nullable, ordinal_position "
            "FROM information_schema.columns "
            f"WHERE table_schema = ''{scope}'' "
            "ORDER BY table_name, ordinal_position"
        )
        rows = con.execute(
            f"SELECT * FROM {spec['query_fn']}('{_ATTACH_ALIAS}', '{inner}')"
        ).fetchall()
    finally:
        con.close()

    tables: dict[str, list[dict]] = {}
    for table_name, column_name, data_type, is_nullable, _pos in rows:
        tables.setdefault(str(table_name), []).append(
            {
                "name": str(column_name),
                "type": str(data_type),
                "nullable": str(is_nullable).upper() == "YES",
            }
        )
    return [{"name": name, "columns": cols} for name, cols in tables.items()]
