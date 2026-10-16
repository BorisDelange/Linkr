"""How an external database's schemas are named and reached once ATTACHed:
the default schema a bare table name resolves in, the schemas an engine keeps
for itself, and the search path that makes every data schema readable.

Shared by db_connect (queries), pushdown (the remote catalogue) and
cohort_derive; db_connect re-exports every name.
"""

import re

import duckdb

# The catalog name every external database is ATTACHed under.
_ATTACH_ALIAS = "ext"
# Engines that speak the MySQL protocol, where a `database` is a schema.
_MYSQL_PROTOCOL = ("mysql", "doris")

# A DuckDB catalog / schema / table identifier we are willing to interpolate
# into SQL. Role names come from client `roles` keys and table names from
# uploaded Parquet filenames, so both are untrusted and must match this before
# being quoted into ATTACH / CREATE VIEW.
# re.ASCII, because IGNORECASE on a str pattern enables Unicode case-folding:
# `[a-z]` then also matches İ (U+0130), ı (U+0131), ſ (U+017F) and K (U+212A).
# None of them can break out of the quoting, so this was never an injection
# vector — but a name could validate here and not round-trip under DuckDB's own
# case-insensitive matching.
_SAFE_IDENT = re.compile(r"[a-z_][a-z0-9_]*", re.IGNORECASE | re.ASCII)


def _scope(config: dict) -> str | None:
    """The default schema: where a bare table name (`FROM patient`) resolves. A
    MySQL/Doris `database` is a schema here, so `database` stands in for it when
    `schema` is blank; MySQL/Doris have no default otherwise, Postgres has
    `public`. Every other schema stays readable as `schema.table`
    (_external_search_path). Validated as a plain identifier since it is
    interpolated into SQL below."""
    is_mysql = config.get("engine") in _MYSQL_PROTOCOL
    scope = (config.get("schema") or config.get("database")) if is_mysql else (config.get("schema") or "public")
    if not scope:
        return None
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", scope):
        raise ValueError(f"invalid schema/database name: {scope!r}")
    return scope


# Schemas an engine keeps for itself. Never data a preset names, and on the
# search path they would put `mysql.user` next to the warehouse's own tables.
# Mirrored by the R/Python client libraries (linkr-py _databases, linkr-r connect).
SYSTEM_SCHEMAS = frozenset({
    "information_schema", "pg_catalog", "pg_toast", "mysql", "sys", "performance_schema", "__internal_schema",
})


# The list as the SQL of a passthrough query, itself inside a DuckDB literal.
_SYSTEM_SCHEMAS_NESTED = ", ".join(f"''{name}''" for name in sorted(SYSTEM_SCHEMAS))


def is_system_schema(name: str) -> bool:
    lowered = name.lower()
    return lowered in SYSTEM_SCHEMAS or lowered.startswith(("pg_temp", "pg_toast"))


def _data_schemas(con: duckdb.DuckDBPyConnection, catalog: str) -> list[str]:
    """The schemas of an attached external database that hold data, sorted. A
    MySQL/Doris `database` is a DuckDB schema of the attach, and the attach sees
    every one the login may read, whatever database the DSN names."""
    rows = con.execute(
        "SELECT schema_name FROM information_schema.schemata WHERE catalog_name = ? ORDER BY schema_name",
        [catalog],
    ).fetchall()
    return [str(r[0]) for r in rows if not is_system_schema(str(r[0]))]


def _external_search_path(
    con: duckdb.DuckDBPyConnection, config: dict, catalog: str = _ATTACH_ALIAS, head: tuple[str, ...] = ("memory",),
) -> str:
    """`head`, the default schema, then every other data schema of the attach.

    DuckDB looks a two-part name (`vocab.concept`) up only through the
    schemas the search path lists: with the default schema alone, a preset naming
    a second schema read "schema does not exist" although the attach held it. A
    bare name two schemas hold resolves to the default, then alphabetically.
    A name that is not a plain identifier is left off, reachable fully qualified."""
    default = _scope(config)
    schemas = _data_schemas(con, catalog)
    ordered = schemas
    if default:
        match = next((s for s in schemas if s.lower() == default.lower()), default)
        ordered = [match, *(s for s in schemas if s != match)]
    return ",".join([*head, *(f'{catalog}."{s}"' for s in ordered if _SAFE_IDENT.fullmatch(s))])
