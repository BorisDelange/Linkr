"""SQL Server and Oracle, reached through DuckDB community extensions.

Neither extension is DuckDB's own: `mssql` (hugr-lab/mssql-extension) and
`oracle_scanner` (krokozyab/quack-oracle) are community builds that DuckDB Labs
does not review. The server never downloads them by itself: an administrator
installs them (`npm run duckdb:extensions -- --community`, or the Docker image),
and a database of either engine fails with that instruction until then.

SQL Server is attached READ_ONLY, but each extension also ships functions that
send SQL to the database past any read-only flag (`mssql_scan` runs a multi-statement batch,
`oracle_execute*` writes). Two guards close that: user SQL may not call them
(db_connect._reject_passthrough_calls), and the login itself must be read-only,
checked at every attach as for Doris.

Oracle: the build of `oracle_scanner` for DuckDB 1.5 attaches only the login's
own schema (a read-only login owns none) and pushes nothing down. So the alias
Linkr queries is an in-memory catalog of views, one per table of the schema read,
each over `oracle_query` — every query reads its tables whole from Oracle: right
answers, but slow on a large warehouse. The views also cast what Oracle sends
as text (`INTEGER`, `NUMBER`, `FLOAT`) back to numbers and lower-case the names
Oracle folded to upper case, so an OMOP schema reads as anywhere else. The build
for DuckDB 2.0 attaches any schema read-only with pushdown: the way to go once
the server moves to 2.0.
"""

from __future__ import annotations

import duckdb

COMMUNITY_EXTENSIONS = {"sqlserver": "mssql", "oracle": "oracle_scanner"}
ENGINE_LABELS = {"sqlserver": "SQL Server", "oracle": "Oracle"}

DEFAULT_PORTS = {"sqlserver": 1433, "oracle": 1521}

# Oracle privileges that only read (or only connect).
_ORACLE_READ_PRIVS = {
    "CREATE SESSION", "SET CONTAINER", "SELECT ANY TABLE", "READ ANY TABLE", "SELECT ANY DICTIONARY",
    "SELECT ANY SEQUENCE",
}
_ORACLE_READ_TABLE_PRIVS = {"SELECT", "READ"}


def _lit(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def secret_name(alias: str) -> str:
    return f"linkr_{alias}"


def not_installed(engine: str) -> ValueError:
    ext = COMMUNITY_EXTENSIONS[engine]
    return ValueError(
        f"The {ENGINE_LABELS[engine]} connector relies on the DuckDB community extension "
        f"'{ext}', which is not installed on this Linkr server. An administrator installs it "
        "once with `npm run duckdb:extensions -- --community` (the Docker image ships it). "
        "Community extensions are not reviewed by DuckDB Labs."
    )


def load(con: duckdb.DuckDBPyConnection, engine: str) -> None:
    """LOAD the engine's extension from the extension directory, never downloading it."""
    try:
        con.execute(f"LOAD {COMMUNITY_EXTENSIONS[engine]}")
    except duckdb.Error as exc:
        raise not_installed(engine) from exc


def attach(con: duckdb.DuckDBPyConnection, alias: str, config: dict, password: str | None) -> None:
    """ATTACH `config`'s database under `alias` (a safe identifier), read-only, its
    login proven read-only."""
    engine = config["engine"]
    port = int(config.get("port") or DEFAULT_PORTS[engine])
    secret = secret_name(alias)
    if engine == "sqlserver":
        # Always encrypted. The extension's build for DuckDB 1.5 does not verify
        # the server's certificate (the 2.0 build does): see docs/planning/duckdb-2-plan.md.
        fields = [f"HOST {_lit(config.get('host') or '')}", f"PORT {port}",
                  f"DATABASE {_lit(config.get('database') or 'master')}",
                  f"USER {_lit(config.get('username') or '')}", f"PASSWORD {_lit(password or '')}",
                  "USE_ENCRYPT true"]
        con.execute(f'CREATE OR REPLACE TEMPORARY SECRET "{secret}" (TYPE mssql, {", ".join(fields)})')
        con.execute(f'ATTACH \'\' AS "{alias}" (TYPE mssql, SECRET "{secret}", READ_ONLY)')
        _require_read_only_sqlserver_login(con, alias, config.get("username") or "")
        return
    fields = [f"HOST {_lit(config.get('host') or '')}", f"PORT {port}",
              f"SERVICE_NAME {_lit(config.get('database') or '')}",
              f"USER {_lit(config.get('username') or '')}", f"PASSWORD {_lit(password or '')}"]
    con.execute(f'CREATE OR REPLACE TEMPORARY SECRET "{secret}" (TYPE oracle, {", ".join(fields)})')
    _require_read_only_oracle_login(con, secret)
    _oracle_views(con, alias, secret, config.get("schema"))


def attach_writable(con: duckdb.DuckDBPyConnection, alias: str, config: dict, password: str | None) -> None:
    """ATTACH a SQL Server database writable under `alias`, with the user's WRITE
    login — the cohort derivation's alone (derive_writers): every other attach is
    read-only, its login checked so."""
    if config.get("engine") != "sqlserver":
        raise ValueError("only SQL Server is written through its extension; Oracle through its driver")
    load(con, "sqlserver")
    from app.services.data.db_host_guard import check_db_host

    check_db_host(config.get("host"))
    port = int(config.get("port") or DEFAULT_PORTS["sqlserver"])
    secret = secret_name(alias)
    fields = [f"HOST {_lit(config.get('host') or '')}", f"PORT {port}",
              f"DATABASE {_lit(config.get('database') or 'master')}",
              f"USER {_lit(config.get('username') or '')}", f"PASSWORD {_lit(password or '')}",
              "USE_ENCRYPT true"]
    con.execute(f'CREATE OR REPLACE TEMPORARY SECRET "{secret}" (TYPE mssql, {", ".join(fields)})')
    con.execute(f'ATTACH \'\' AS "{alias}" (TYPE mssql, SECRET "{secret}")')


# ── read-only logins ─────────────────────────────────────────────────────────

def _scalar_row(con: duckdb.DuckDBPyConnection, sql: str) -> tuple:
    return con.execute(sql).fetchone() or ()


def _require_read_only_sqlserver_login(con: duckdb.DuckDBPyConnection, alias: str, login: str = "") -> None:
    checks = ("sysadmin", "db_owner", "db_datawriter", "db_ddladmin")
    inner = (
        "SELECT IS_SRVROLEMEMBER(''sysadmin'') AS sysadmin, IS_ROLEMEMBER(''db_owner'') AS db_owner, "
        "IS_ROLEMEMBER(''db_datawriter'') AS db_datawriter, IS_ROLEMEMBER(''db_ddladmin'') AS db_ddladmin, "
        "HAS_PERMS_BY_NAME(DB_NAME(), ''DATABASE'', ''INSERT'') AS can_insert, "
        "HAS_PERMS_BY_NAME(DB_NAME(), ''DATABASE'', ''UPDATE'') AS can_update, "
        "HAS_PERMS_BY_NAME(DB_NAME(), ''DATABASE'', ''DELETE'') AS can_delete, "
        "HAS_PERMS_BY_NAME(DB_NAME(), ''DATABASE'', ''CREATE TABLE'') AS can_create, "
        "HAS_PERMS_BY_NAME(DB_NAME(), ''DATABASE'', ''ALTER'') AS can_alter"
    )
    row = _scalar_row(con, f"SELECT * FROM mssql_scan('{alias}', '{inner}')")
    names = [*checks, "INSERT", "UPDATE", "DELETE", "CREATE TABLE", "ALTER"]
    if len(row) != len(names):
        raise ValueError("cannot verify that this SQL Server login is read-only")
    held = [name for name, value in zip(names, row) if value]
    held += [p for p in _sqlserver_granted_permissions(con, alias) if p not in held]
    if held:
        raise ValueError(
            "Linkr only connects to SQL Server with a read-only login (db_datareader or SELECT "
            f"grants); this one also holds {', '.join(held)}. {_sqlserver_remedy(held, login)}"
        )


_SQLSERVER_SERVER_ROLES = {"sysadmin"}
_SQLSERVER_DATABASE_ROLES = {"db_owner", "db_datawriter", "db_ddladmin"}


def _sqlserver_remedy(held: list[str], login: str) -> str:
    """What a DBA runs so the login only reads: leave the roles, deny the rest.
    A DENY overrides a grant inherited through a role, `public` included."""
    who = "[" + (login or "<login>").replace("]", "]]") + "]"
    steps = [f"ALTER SERVER ROLE {r} DROP MEMBER {who}" for r in held if r in _SQLSERVER_SERVER_ROLES]
    steps += [f"ALTER ROLE {r} DROP MEMBER {who}" for r in held if r in _SQLSERVER_DATABASE_ROLES]
    perms = [p for p in held if p not in _SQLSERVER_SERVER_ROLES | _SQLSERVER_DATABASE_ROLES]
    if perms:
        steps.append(f"DENY {', '.join(perms)} TO {who}")
    remedy = "A database administrator can remove them: " + "; ".join(steps) + "."
    if any(p.split(" ", 1)[0] == "EXECUTE" for p in perms):
        remedy += (" The login must not be able to execute procedures either: EXECUTE is often"
                   " inherited from a GRANT EXECUTE TO public, which REVOKE EXECUTE FROM public"
                   " removes for every user instead.")
    return remedy


# Permissions a read-only login must not hold on the database or on a schema, as
# fn_my_permissions spells them. Families go by their leading word, so every
# member is refused (EXECUTE ANY EXTERNAL SCRIPT, BACKUP LOG, ADMINISTER DATABASE
# BULK OPERATIONS, KILL DATABASE CONNECTION…), the bare EXECUTE included.
_SQLSERVER_WRITE_PERMS = {"INSERT", "UPDATE", "DELETE", "CONTROL", "TAKE OWNERSHIP", "IMPERSONATE", "CHECKPOINT"}
_SQLSERVER_WRITE_FAMILIES = ("ALTER", "CREATE", "EXECUTE", "BACKUP", "ADMINISTER", "KILL", "ENABLE")


def _is_sqlserver_write_permission(name: str) -> bool:
    name = " ".join(name.upper().split())
    return name in _SQLSERVER_WRITE_PERMS or name.split(" ", 1)[0] in _SQLSERVER_WRITE_FAMILIES


def _sqlserver_granted_permissions(con: duckdb.DuckDBPyConnection, alias: str) -> list[str]:
    """The writing permissions the login holds on the database, on any user schema
    or on any user object, by grant or by ownership — none of them visible to
    HAS_PERMS_BY_NAME at the database level. A grant goes by what the login can
    effectively do, so the DENY of `_sqlserver_remedy` clears it."""
    inner = (
        "SELECT DISTINCT permission_name FROM ("
        "SELECT permission_name COLLATE DATABASE_DEFAULT AS permission_name FROM fn_my_permissions(NULL, 'DATABASE') "
        "UNION ALL SELECT p.permission_name COLLATE DATABASE_DEFAULT FROM sys.schemas s "
        "CROSS APPLY fn_my_permissions(s.name, 'SCHEMA') p "
        "WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA') "
        "UNION ALL SELECT dp.permission_name COLLATE DATABASE_DEFAULT FROM sys.database_permissions dp "
        "JOIN sys.objects o ON o.object_id = dp.major_id "
        "WHERE dp.class = 1 AND dp.state IN ('G', 'W') AND o.is_ms_shipped = 0 "
        "AND HAS_PERMS_BY_NAME(QUOTENAME(SCHEMA_NAME(o.schema_id)) + '.' + QUOTENAME(o.name), 'OBJECT', "
        "dp.permission_name, COL_NAME(dp.major_id, NULLIF(dp.minor_id, 0)), "
        "CASE WHEN dp.minor_id = 0 THEN NULL ELSE 'COLUMN' END) = 1 "
        "UNION ALL SELECT 'CONTROL' COLLATE DATABASE_DEFAULT FROM sys.objects o "
        "WHERE o.principal_id = DATABASE_PRINCIPAL_ID() AND o.is_ms_shipped = 0) perms"
    ).replace("'", "''")
    rows = con.execute(f"SELECT * FROM mssql_scan('{alias}', '{inner}')").fetchall()
    return sorted({str(r[0]).strip().upper() for r in rows if r and r[0] and _is_sqlserver_write_permission(str(r[0]))})


def _oracle_rows(con: duckdb.DuckDBPyConnection, secret: str, sql: str) -> list[tuple]:
    return con.execute(f"SELECT * FROM oracle_query({_lit(secret)}, {_lit(sql)})").fetchall()


def _require_read_only_oracle_login(con: duckdb.DuckDBPyConnection, secret: str) -> None:
    system = {r[0] for r in _oracle_rows(con, secret, "SELECT privilege FROM session_privs")}
    on_tables = {r[0] for r in _oracle_rows(
        con, secret,
        "SELECT privilege FROM user_tab_privs WHERE grantee = USER "
        "UNION SELECT privilege FROM role_tab_privs",
    )}
    owned = int(_oracle_rows(con, secret, "SELECT COUNT(*) FROM user_tables")[0][0])
    held = sorted(system - _ORACLE_READ_PRIVS) + sorted(on_tables - _ORACLE_READ_TABLE_PRIVS)
    if held or owned:
        detail = ", ".join(held) or f"owns {owned} table(s)"
        raise ValueError(
            "Linkr only connects to Oracle with a read-only login that owns no table (CREATE "
            f"SESSION and SELECT grants on another schema); this one {'holds ' if held else ''}{detail}"
        )


# ── Oracle: typed, lower-case views ──────────────────────────────────────────

def _oracle_name(name: str) -> str:
    """What a query calls an Oracle name: lower case when Oracle folded it to upper."""
    return name.lower() if name == name.upper() else name


def _number(value: object) -> int | None:
    # all_tab_columns comes back through oracle_query as text.
    return None if value is None or value == "" else int(float(value))


def _cast(data_type: str, precision: int | None, scale: int | None) -> str | None:
    if data_type == "NUMBER":
        if scale == 0:
            return "BIGINT"
        if precision is not None and scale is not None:
            return f"DECIMAL({precision},{scale})"
        return "DOUBLE"
    if data_type in ("FLOAT", "BINARY_FLOAT", "BINARY_DOUBLE"):
        return "DOUBLE"
    return None


def _quoted(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _oracle_views(con: duckdb.DuckDBPyConnection, alias: str, secret: str, schema: str | None) -> None:
    owner = _lit(schema.upper()) if schema else "USER"
    columns = _oracle_rows(con, secret, (
        "SELECT owner, table_name, column_name, data_type, data_precision, data_scale FROM all_tab_columns "
        f"WHERE owner = {owner} ORDER BY table_name, column_id"
    ))
    con.execute(f"ATTACH ':memory:' AS \"{alias}\"")
    tables: dict[tuple[str, str], list[tuple[str, str | None]]] = {}
    for table_owner, table, column, data_type, precision, scale in columns:
        tables.setdefault((table_owner, table), []).append(
            (column, _cast(str(data_type), _number(precision), _number(scale))))
    for (table_owner, table), cols in tables.items():
        remote = f"SELECT {', '.join(_quoted(c) for c, _ in cols)} FROM {_quoted(table_owner)}.{_quoted(table)}"
        exprs = ", ".join(
            f"CAST({_quoted(c)} AS {cast}) AS {_quoted(_oracle_name(c))}" if cast else f"{_quoted(c)} AS {_quoted(_oracle_name(c))}"
            for c, cast in cols
        )
        con.execute(
            f'CREATE VIEW "{alias}".main.{_quoted(_oracle_name(table))} AS '
            f"SELECT {exprs} FROM oracle_query({_lit(secret)}, {_lit(remote)})"
        )
