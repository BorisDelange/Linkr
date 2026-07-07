"""Server-side connection to external SQL databases (Postgres today).

Uses the DuckDB ``postgres`` extension to ATTACH a live database read-only and
introspect its schema — same SQL dialect as the rest of the app, and no extra
hard dependency (DuckDB is already required). The password is passed in per call
and never stored: it lives only for the duration of the connection.
"""

import re

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


def _validate_schema(schema: str) -> str:
    # `schema` is interpolated into SQL below; reject anything that isn't a
    # plain identifier so it can't break out of a quoted string.
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", schema):
        raise ValueError(f"invalid schema name: {schema!r}")
    return schema


def _attach(con: duckdb.DuckDBPyConnection, config: dict, password: str | None) -> None:
    dsn = _pg_dsn(config, password)
    con.execute(f"ATTACH '{dsn}' AS {_ATTACH_ALIAS} (TYPE postgres, READ_ONLY)")


def query_postgres(
    config: dict, password: str | None, sql: str
) -> list[dict]:
    """Run read-only SQL against the attached Postgres and return rows as dicts.

    The search_path is set to the attached catalog + schema so the caller's SQL
    can use bare table names (``FROM patients``), matching the DuckDB-WASM path.
    Date/time values are returned as ISO strings for JSON transport.
    """
    schema = _validate_schema(config.get("schema") or "public")
    con = _connect()
    try:
        _attach(con, config, password)
        con.execute(f'SET search_path TO {_ATTACH_ALIAS}.{schema}')
        rel = con.execute(sql)
        if rel.description is None:
            return []
        names = [d[0] for d in rel.description]
        return [_row_to_json(dict(zip(names, row))) for row in rel.fetchall()]
    finally:
        con.close()


def _row_to_json(row: dict) -> dict:
    import datetime
    from decimal import Decimal

    out: dict = {}
    for k, v in row.items():
        if isinstance(v, (datetime.date, datetime.datetime)):
            out[k] = v.isoformat()
        elif isinstance(v, Decimal):
            out[k] = float(v)
        else:
            out[k] = v
    return out


def introspect_postgres(config: dict, password: str | None) -> list[dict]:
    """ATTACH the Postgres database read-only and return its tables + columns.

    Shape mirrors the frontend's IntrospectedTable[]:
        [{ "name": str, "columns": [{ "name", "type", "nullable" }] }]
    Raises on connection/permission failure — the caller turns it into a result.
    """
    schema = _validate_schema(config.get("schema") or "public")
    con = _connect()
    try:
        _attach(con, config, password)
        # Passthrough to Postgres' own information_schema (via postgres_query) so
        # column types come back as native Postgres names (integer, text, date)
        # rather than DuckDB-normalized ones. Single-quotes are doubled for the
        # nested SQL literal; `schema` is a validated identifier from config.
        inner = (
            "SELECT table_name, column_name, data_type, is_nullable, ordinal_position "
            "FROM information_schema.columns "
            f"WHERE table_schema = ''{schema}'' "
            "ORDER BY table_name, ordinal_position"
        )
        rows = con.execute(
            f"SELECT * FROM postgres_query('{_ATTACH_ALIAS}', '{inner}')"
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
