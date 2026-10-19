"""The engines of the database matrix and how Linkr reaches each one.

Every engine is read the way the app reads it, through `db_connect`:
- `parquet`: a folder of Parquet files (the reference every other engine is compared with);
- `duckdb`, `sqlite`: a file on the server;
- `postgresql`, `mysql`: a server, attached into DuckDB, logged in with a read-only role;
- `doris`: an existing Doris holding the same tables (MATRIX_DORIS_HOST), read with and
  without pushdown — the matrix does not load or run one, it is too heavy for a laptop.

Oracle and SQL Server have no server connector in Linkr yet: they are listed so the
report says so, not silently skipped.

Server addresses come from the environment, defaulting to the SPE simulation's
datamarts (docker/spe-sim/docker-compose.yml).
"""

from __future__ import annotations

import os

PASSWORD = os.environ.get("DATAMART_PASSWORD", "SpeSim_2026!")
READER = "linkr_ro"
SCHEMA = "omop"

ALL = ["parquet", "duckdb", "sqlite", "postgresql", "mysql", "doris", "oracle", "sqlserver"]
NOT_SUPPORTED = {
    "oracle": "Linkr has no server connector for Oracle yet",
    "sqlserver": "Linkr has no server connector for SQL Server yet",
}


def _env(engine: str, key: str, default: str | None = None) -> str | None:
    return os.environ.get(f"MATRIX_{engine.upper()}_{key}", default)


def admin_config(engine: str) -> dict:
    """The login that loads the data: the datamart's owner."""
    if engine == "postgresql":
        host, port = _env(engine, "HOST", "datamart-postgres"), _env(engine, "PORT", "5432")
        return {
            "dsn": f"host={host} port={port} dbname=datamart user=linkr_reader password={PASSWORD}",
            "load_schema": SCHEMA,
        }
    if engine == "mysql":
        host, port = _env(engine, "HOST", "datamart-mysql"), _env(engine, "PORT", "3306")
        return {"dsn": f"host={host} port={port} user=root password={PASSWORD}", "load_schema": SCHEMA}
    raise ValueError(f"no admin login for {engine}")


def read_only_grants(engine: str) -> list[str]:
    """Create the read-only login Linkr connects with, as an SPE would hand it over."""
    if engine == "postgresql":
        return [
            f"DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{READER}') "
            f"THEN CREATE ROLE {READER} LOGIN PASSWORD '{PASSWORD}'; END IF; END $$",
            f"GRANT USAGE ON SCHEMA {SCHEMA} TO {READER}",
            f"GRANT SELECT ON ALL TABLES IN SCHEMA {SCHEMA} TO {READER}",
        ]
    if engine == "mysql":
        return [
            f"CREATE USER IF NOT EXISTS '{READER}'@'%' IDENTIFIED BY '{PASSWORD}'",
            f"GRANT SELECT, SHOW VIEW ON {SCHEMA}.* TO '{READER}'@'%'",
        ]
    return []


def linkr_config(engine: str) -> tuple[dict, str | None] | None:
    """The connectionConfig and password Linkr would store for this database, or
    None when the engine is not reachable from here."""
    if engine == "postgresql":
        return ({
            "engine": "postgresql", "host": _env(engine, "HOST", "datamart-postgres"),
            "port": int(_env(engine, "PORT", "5432")), "database": "datamart",
            "username": READER, "schema": SCHEMA,
        }, PASSWORD)
    if engine == "mysql":
        return ({
            "engine": "mysql", "host": _env(engine, "HOST", "datamart-mysql"),
            "port": int(_env(engine, "PORT", "3306")), "database": SCHEMA, "username": READER,
        }, PASSWORD)
    if engine == "doris":
        host = _env(engine, "HOST")
        if not host:
            return None
        return ({
            "engine": "doris", "host": host, "port": int(_env(engine, "PORT", "9030")),
            "database": _env(engine, "DATABASE", SCHEMA), "username": _env(engine, "USER", "reader"),
        }, _env(engine, "PASSWORD", ""))
    return None
