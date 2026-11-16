"""Whether the login Linkr holds for a PostgreSQL or MySQL database can write.

Both are attached READ_ONLY, which keeps every read through the attached tables
from writing. `postgres_query(db, text)` / `mysql_query(db, text)` send their text
to the database as is: db_connect lets one read statement through, but a read can
still call a function that writes, under the login's rights. So the login is
checked at attach. One that can write, or that the check cannot read, still
attaches (sites set up before the check keep working), but the text functions
are refused on that database (`require_read_only`) and a warning is logged.

Doris (attached writable) refuses such a login at attach instead
(db_connect._require_read_only_doris_login), as SQL Server and Oracle do
(community_engines).
"""

from __future__ import annotations

import logging
import threading
import time
import weakref
from dataclasses import dataclass

import duckdb

from app.services.data.community_engines import LoginNotReadOnly
from app.services.data.db_schemas import _scope

logger = logging.getLogger(__name__)

# A verdict serves every connection of the same login for this long; a connection
# keeps the one it was attached with when the cache has none fresher.
VERDICT_TTL = 300.0

_LABELS = {"postgresql": "PostgreSQL", "mysql": "MySQL"}
_FUNCTION_KIND = {"POSTGRES_QUERY": ("postgres", "postgresql"), "MYSQL_QUERY": ("mysql", "mysql")}


@dataclass(frozen=True)
class Verdict:
    engine: str
    held: tuple[str, ...] = ()
    verified: bool = True
    steps: str = ""

    @property
    def read_only(self) -> bool:
        return self.verified and not self.held

    def refusal(self, function: str) -> LoginNotReadOnly:
        label = _LABELS.get(self.engine, self.engine)
        fn = function.lower()
        why = (
            f"This {label} login can write ({', '.join(self.held)})" if self.verified
            else f"Linkr could not verify that this {label} login is read-only"
        )
        message = (
            f"{why}, so {fn}(), whose text goes to the database as is, is refused on this database. "
            "Its tables still read as usual, through Linkr's read-only connection. "
            f"To use {fn}(), give Linkr a read-only login for this database: {self.steps}."
        )
        code = f"{'postgres' if self.engine == 'postgresql' else self.engine}_login_" + (
            "not_read_only" if self.verified else "unverified")
        values = {"function": fn, "steps": self.steps}
        if self.verified:
            values["held"] = ", ".join(self.held)
        return LoginNotReadOnly(code, message, **values)


READ_ONLY = Verdict("doris")


# ── PostgreSQL ───────────────────────────────────────────────────────────────

# Every role the login may act as counts: one it inherits from, and one it may
# SET ROLE to, which `set_config('role', …)` does inside a SELECT. Ownership
# implies every privilege; a SECURITY DEFINER function runs with its owner's
# rights; dblink opens a connection of its own, outside the read-only transaction.
POSTGRES_CHECK_SQL = """
WITH member_roles AS (
  SELECT oid, rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication
  FROM pg_roles WHERE pg_has_role(current_user, oid, 'MEMBER')
), data_schemas AS (
  SELECT oid, nspowner FROM pg_namespace
  WHERE nspname <> 'information_schema' AND nspname NOT LIKE 'pg\\_%'
), relations AS (
  SELECT c.oid, c.relkind, c.relowner FROM pg_class c JOIN data_schemas s ON s.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
)
SELECT
  current_user::text AS login,
  array_to_string(ARRAY(
    SELECT DISTINCT a.name FROM member_roles r CROSS JOIN LATERAL (VALUES
      ('SUPERUSER', r.rolsuper), ('CREATEROLE', r.rolcreaterole), ('CREATEDB', r.rolcreatedb),
      ('BYPASSRLS', r.rolbypassrls), ('REPLICATION', r.rolreplication)) AS a(name, held)
    WHERE a.held ORDER BY 1
  ), ',') AS attributes,
  array_to_string(ARRAY(
    SELECT rolname::text FROM member_roles WHERE rolname LIKE 'pg\\_%' ORDER BY 1
  ), ',') AS predefined_roles,
  array_to_string(ARRAY(
    SELECT DISTINCT p.name FROM relations c CROSS JOIN member_roles r
    CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(name)
    WHERE CASE WHEN c.relkind = 'S' THEN false
               WHEN p.name IN ('INSERT', 'UPDATE', 'REFERENCES') THEN has_any_column_privilege(r.oid, c.oid, p.name)
               ELSE has_table_privilege(r.oid, c.oid, p.name) END
    ORDER BY 1
  ), ',') AS table_privileges,
  array_to_string(ARRAY(
    SELECT DISTINCT p.name FROM relations c CROSS JOIN member_roles r
    CROSS JOIN unnest(ARRAY['USAGE', 'UPDATE']) AS p(name)
    WHERE CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(r.oid, c.oid, p.name) ELSE false END
    ORDER BY 1
  ), ',') AS sequence_privileges,
  EXISTS (
    SELECT 1 FROM data_schemas s CROSS JOIN member_roles r WHERE has_schema_privilege(r.oid, s.oid, 'CREATE')
  ) AS schema_create,
  EXISTS (
    SELECT 1 FROM member_roles r WHERE has_database_privilege(r.oid, current_database(), 'CREATE')
  ) AS database_create,
  (SELECT count(*) FROM relations WHERE relowner IN (SELECT oid FROM member_roles))
    + (SELECT count(*) FROM data_schemas WHERE nspowner IN (SELECT oid FROM member_roles)) AS owned,
  (SELECT count(*) FROM pg_proc f JOIN data_schemas s ON s.oid = f.pronamespace
   WHERE f.prosecdef AND f.proowner NOT IN (SELECT oid FROM member_roles)
     AND EXISTS (SELECT 1 FROM member_roles r WHERE has_function_privilege(r.oid, f.oid, 'EXECUTE'))
  ) AS security_definer,
  EXISTS (
    SELECT 1 FROM pg_proc f WHERE f.proname IN ('dblink', 'dblink_exec', 'dblink_connect', 'dblink_send_query')
      AND EXISTS (SELECT 1 FROM member_roles r WHERE has_function_privilege(r.oid, f.oid, 'EXECUTE'))
  ) AS dblink
""".strip()

_POSTGRES_COLUMNS = 10
# Predefined roles that only read (pg_monitor bundles the three after it).
_POSTGRES_READ_ROLES = frozenset({
    "pg_read_all_data", "pg_read_all_settings", "pg_read_all_stats", "pg_stat_scan_tables", "pg_monitor",
})


def _names(value: object) -> list[str]:
    """A comma-joined list of names (array_to_string), as postgres_query answers it."""
    if value is None:
        return []
    if not isinstance(value, str):
        raise TypeError("unexpected shape of the PostgreSQL privilege check")
    return [n for n in value.split(",") if n]


def postgres_write_privileges(rows: list[tuple]) -> list[str]:
    """What lets the login write, from POSTGRES_CHECK_SQL's one row. Fails closed:
    any other shape cannot prove the login read-only."""
    if len(rows) != 1 or len(rows[0]) != _POSTGRES_COLUMNS:
        raise ValueError("unexpected shape of the PostgreSQL privilege check")
    (_login, attributes, roles, tables, sequences, schema_create, database_create,
     owned, security_definer, dblink) = rows[0]
    held = _names(attributes)
    held += [r for r in _names(roles) if r not in _POSTGRES_READ_ROLES]
    held += _names(tables)
    held += [f"{p} ON SEQUENCE" for p in _names(sequences)]
    if schema_create:
        held.append("CREATE ON SCHEMA")
    if database_create:
        held.append("CREATE ON DATABASE")
    if owned:
        held.append("OWNERSHIP")
    if security_definer:
        held.append("EXECUTE ON SECURITY DEFINER FUNCTION")
    if dblink:
        held.append("dblink")
    return list(dict.fromkeys(held))


def _pg_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _scope_or(config: dict, default: str) -> str:
    try:
        return _scope(config) or default
    except ValueError:
        return default


def postgres_steps(config: dict) -> str:
    schema = _pg_ident(_scope_or(config, "public"))
    database = _pg_ident(str(config.get("database") or "<database>"))
    return (
        "CREATE ROLE linkr_reader LOGIN PASSWORD '…'; "
        f"GRANT CONNECT ON DATABASE {database} TO linkr_reader; "
        f"GRANT USAGE ON SCHEMA {schema} TO linkr_reader; "
        f"GRANT SELECT ON ALL TABLES IN SCHEMA {schema} TO linkr_reader"
    )


# ── MySQL / MariaDB ──────────────────────────────────────────────────────────
# mysql_query() prepares its text to learn the result's columns, and MySQL does not
# prepare SHOW GRANTS: the check reads information_schema instead. It lists the
# login's own privileges — every account's for one that may read the grant tables,
# hence the GRANTEE filter — but neither what its roles allow nor its rights on a
# routine, which may write as its definer.

# Privileges that only read. Anything else — static (INSERT, FILE, PROCESS…),
# dynamic (any *_ADMIN…) — lets the login write or reach past its data.
_MYSQL_READ_PRIVILEGES = frozenset({
    "USAGE", "SELECT", "SHOW VIEW", "SHOW DATABASES", "SHOW_ROUTINE", "SHOW CREATE ROUTINE",
})

MYSQL_LOGIN_SQL = (
    "SELECT CURRENT_USER(), (SELECT COUNT(*) FROM information_schema.APPLICABLE_ROLES), "
    "(SELECT COUNT(*) FROM information_schema.ROUTINES "
    "WHERE ROUTINE_SCHEMA NOT IN ('mysql', 'sys', 'information_schema', 'performance_schema'))"
)
MYSQL_PRIVILEGES_SQL = " UNION ALL ".join(
    f"SELECT GRANTEE, PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.{view}"
    for view in ("USER_PRIVILEGES", "SCHEMA_PRIVILEGES", "TABLE_PRIVILEGES", "COLUMN_PRIVILEGES")
)


def mysql_grantee(current_user: str) -> str:
    """`reader@%` (CURRENT_USER()) as information_schema spells its grantee."""
    user, _, host = current_user.rpartition("@")
    return f"'{user}'@'{host}'"


def mysql_write_privileges(current_user: str, roles: int, routines: int, rows: list[tuple]) -> list[str]:
    """What lets the login write, from MYSQL_PRIVILEGES_SQL's rows (grantee,
    privilege, grantable). A login holding a role, active or not, stays unverified:
    SET ROLE makes one active, and nothing it can read says what a role allows. So
    does one that sees a routine: it may hold EXECUTE on it."""
    if roles:
        raise ValueError("the login holds roles, whose privileges it cannot read")
    if routines:
        raise ValueError("the login sees routines, whose rights it cannot read")
    grantees = {mysql_grantee(current_user), "PUBLIC"}
    own = [(str(p).upper(), str(g).upper()) for who, p, g in rows if who in grantees]
    if not own:
        raise ValueError("information_schema lists no privilege of the login")
    held = [p for p, _ in own if p not in _MYSQL_READ_PRIVILEGES]
    if any(g == "YES" for _, g in own):
        held.append("GRANT OPTION")
    return list(dict.fromkeys(held))


def _mysql_ident(name: str) -> str:
    return "`" + name.replace("`", "``") + "`"


def mysql_steps(config: dict) -> str:
    database = _mysql_ident(_scope_or(config, "<database>"))
    return (
        "CREATE USER 'linkr_reader'@'%' IDENTIFIED BY '…'; "
        f"GRANT SELECT, SHOW VIEW ON {database}.* TO 'linkr_reader'@'%'"
    )


# ── Verdicts ─────────────────────────────────────────────────────────────────

_lock = threading.Lock()
_verdicts: dict[tuple, tuple[float, Verdict]] = {}
_attached: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()
_warned: set[tuple] = set()


def login_key(config: dict) -> tuple:
    return tuple(str(config.get(k) or "") for k in ("engine", "host", "port", "database", "username"))


def _literal(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def _compute(con: duckdb.DuckDBPyConnection, alias: str, config: dict) -> Verdict:
    engine = config.get("engine")
    if engine == "postgresql":
        steps = postgres_steps(config)
        rows = con.execute(f"SELECT * FROM postgres_query('{alias}', {_literal(POSTGRES_CHECK_SQL)})").fetchall()
        return Verdict(engine, tuple(postgres_write_privileges(rows)), steps=steps)
    steps = mysql_steps(config)
    ((current_user, roles, routines),) = con.execute(
        f"SELECT * FROM mysql_query('{alias}', {_literal(MYSQL_LOGIN_SQL)})"
    ).fetchall()
    rows = con.execute(f"SELECT * FROM mysql_query('{alias}', {_literal(MYSQL_PRIVILEGES_SQL)})").fetchall()
    return Verdict("mysql", tuple(mysql_write_privileges(current_user, roles, routines, rows)), steps=steps)


def _unverified(engine: str, config: dict) -> Verdict:
    steps = postgres_steps(config) if engine == "postgresql" else mysql_steps(config)
    return Verdict(engine, verified=False, steps=steps)


def check(con: duckdb.DuckDBPyConnection, alias: str, config: dict) -> Verdict:
    """The verdict on the login of the database just attached as `alias` (a safe
    identifier), remembered for `con`. Never raises: a check that fails leaves the
    login unverified, which only refuses the text functions."""
    key = login_key(config)
    with _lock:
        hit = _verdicts.get(key)
    if hit and time.monotonic() - hit[0] < VERDICT_TTL:
        verdict = hit[1]
    else:
        engine = str(config.get("engine"))
        try:
            verdict = _compute(con, alias, config)
        except Exception as exc:  # noqa: BLE001 — unverified: the attach goes on, the text functions are refused
            logger.info("could not verify the %s login of %s: %s", engine, config.get("host"), str(exc).splitlines()[0][:300])
            verdict = _unverified(engine, config)
        else:
            with _lock:
                _verdicts[key] = (time.monotonic(), verdict)
        _warn(key, config, verdict)
    remember(con, alias, key, verdict)
    return verdict


def _warn(key: tuple, config: dict, verdict: Verdict) -> None:
    if verdict.read_only:
        return
    with _lock:
        if (key, verdict) in _warned:
            return
        _warned.add((key, verdict))
    fn = "postgres_query" if verdict.engine == "postgresql" else "mysql_query"
    what = f"can write ({', '.join(verdict.held)})" if verdict.verified else "could not be verified as read-only"
    logger.warning(
        "The %s login %r of database %r on %s %s. Its tables are still read through a read-only "
        "attach, but %s() is refused on it. A read-only login is recommended: %s.",
        _LABELS.get(verdict.engine, verdict.engine), config.get("username"), config.get("database"),
        config.get("host"), what, fn, verdict.steps,
    )


def remember(con: duckdb.DuckDBPyConnection, alias: str, key: tuple | None, verdict: Verdict) -> None:
    with _lock:
        _attached.setdefault(con, {})[alias.lower()] = (key, verdict)


def forget(config: dict) -> None:
    """Drop the cached verdict on `config`'s login: the next attach checks again."""
    with _lock:
        _verdicts.pop(login_key(config), None)


def _current(key: tuple | None, stored: Verdict) -> Verdict:
    with _lock:
        hit = _verdicts.get(key) if key is not None else None
    return hit[1] if hit and time.monotonic() - hit[0] < VERDICT_TTL else stored


def _databases(con: duckdb.DuckDBPyConnection, kind: str) -> list[str]:
    rows = con.execute("SELECT database_name, type FROM duckdb_databases()").fetchall()
    return [str(name) for name, type_ in rows if str(type_).lower() == kind]


def require_read_only(con: duckdb.DuckDBPyConnection, alias: str | None, function: str) -> None:
    """Refuse `function` (POSTGRES_QUERY / MYSQL_QUERY) on the database `alias`
    names — any of its kind when `alias` is not a plain string — unless that
    database's login was proven read-only. A database attached without a verdict
    counts as unverified."""
    kind, engine = _FUNCTION_KIND[function]
    with _lock:
        known = dict(_attached.get(con, {}))
    for name in _databases(con, kind):
        if alias is not None and name.lower() != alias.lower():
            continue
        entry = known.get(name.lower())
        verdict = _current(*entry) if entry else _unverified(engine, {"engine": engine})
        if not verdict.read_only:
            raise verdict.refusal(function)
