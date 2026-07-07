"""Server-side connection to external SQL databases (Postgres today).

Uses the DuckDB ``postgres`` extension to ATTACH a live database read-only and
introspect its schema — same SQL dialect as the rest of the app, and no extra
hard dependency (DuckDB is already required). The password is passed in per call
and never stored: it lives only for the duration of the connection.
"""

import duckdb

from app.config import settings

_ATTACH_ALIAS = "ext"


def _ext_dir() -> str:
    d = settings.data_path / "_duckdb_ext"
    d.mkdir(parents=True, exist_ok=True)
    return d.as_posix()


def _connect() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    # Persist installed extensions under data_dir so INSTALL only hits the
    # network once (and can be pre-warmed at build time in an offline image).
    con.execute(f"SET extension_directory = '{_ext_dir()}'")
    con.execute("INSTALL postgres")
    con.execute("LOAD postgres")
    return con


def _pg_dsn(config: dict, password: str | None) -> str:
    """Build a libpq DSN from a DatabaseConnectionConfig-shaped dict."""
    parts: list[str] = []
    if host := config.get("host"):
        parts.append(f"host={host}")
    if port := config.get("port"):
        parts.append(f"port={int(port)}")
    if database := config.get("database"):
        parts.append(f"dbname={database}")
    if username := config.get("username"):
        parts.append(f"user={username}")
    if password:
        parts.append(f"password={password}")
    return " ".join(parts)


def introspect_postgres(config: dict, password: str | None) -> list[dict]:
    """ATTACH the Postgres database read-only and return its tables + columns.

    Shape mirrors the frontend's IntrospectedTable[]:
        [{ "name": str, "columns": [{ "name", "type", "nullable" }] }]
    Raises on connection/permission failure — the caller turns it into a result.
    """
    schema = config.get("schema") or "public"
    dsn = _pg_dsn(config, password)
    con = _connect()
    try:
        con.execute(
            f"ATTACH '{dsn}' AS {_ATTACH_ALIAS} (TYPE postgres, READ_ONLY, SCHEMA '{schema}')"
        )
        rows = con.execute(
            f"""
            SELECT table_name, column_name, data_type, is_nullable, ordinal_position
            FROM {_ATTACH_ALIAS}.information_schema.columns
            WHERE table_schema = ?
            ORDER BY table_name, ordinal_position
            """,
            [schema],
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
