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
import re
import threading
import time
import weakref
from collections.abc import Callable
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

# Privileges that only read. Anything else — static (INSERT, FILE, PROCESS…),
# dynamic (any *_ADMIN…), ALL — lets the login write or reach past its data.
_MYSQL_READ_PRIVILEGES = frozenset({
    "USAGE", "SELECT", "SHOW VIEW", "SHOW DATABASES", "SHOW_ROUTINE", "SHOW CREATE ROUTINE",
})
_MYSQL_TOKEN = re.compile(
    r"`(?:[^`]|``)*`|'(?:[^'\\]|\\.|'')*'|\"(?:[^\"\\]|\\.|\"\")*\"|[(),@.*]|[^\s(),@.*`'\"]+"
)
_MYSQL_ROLE = re.compile(
    r"(?:`(?:[^`]|``)*`|'(?:[^'\\]|'')*'|\w+)(?:@(?:`(?:[^`]|``)*`|'(?:[^'\\]|'')*'|[\w.%-]+))?"
)


@dataclass(frozen=True)
class MySQLGrant:
    privileges: tuple[str, ...] = ()
    on: str | None = None
    roles: tuple[str, ...] = ()
    grant_option: bool = False
    admin_option: bool = False

    @property
    def writes(self) -> list[str]:
        held = [p for p in self.privileges if p not in _MYSQL_READ_PRIVILEGES]
        if self.grant_option:
            held.append("GRANT OPTION")
        if self.admin_option:
            held.append("ADMIN OPTION")
        return held


def parse_mysql_grant(line: str) -> MySQLGrant | None:
    """One line of MySQL's or MariaDB's SHOW GRANTS: a grant of privileges
    (`GRANT SELECT (a), INSERT ON db.t TO u@h`) or of roles (`GRANT r@% TO u@h`).
    None for a line that grants nothing (a partial REVOKE, MariaDB's SET DEFAULT
    ROLE); ValueError for one it cannot read."""
    tokens = _MYSQL_TOKEN.findall(line)
    head = tokens[0].upper() if tokens else ""
    if head in ("REVOKE", "SET"):
        return None
    if head != "GRANT":
        raise ValueError("unexpected SHOW GRANTS line")
    items: list[list[str]] = [[]]
    depth, keyword, at = 0, None, len(tokens)
    for i in range(1, len(tokens)):
        token = tokens[i]
        if token == "(":
            depth += 1
        elif token == ")":
            depth -= 1
        elif depth:
            continue
        elif token.upper() in ("ON", "TO") and items[-1]:
            keyword, at = token.upper(), i
            break
        elif token == ",":
            items.append([])
        else:
            items[-1].append(token)
    if keyword is None or depth or not all(items):
        raise ValueError("unexpected SHOW GRANTS line")
    rest = tokens[at + 1:]
    words = [t.upper() for t in rest]
    if keyword == "TO":
        roles = tuple("".join(item) for item in items)
        if not all(_MYSQL_ROLE.fullmatch(r) for r in roles):
            raise ValueError("unexpected SHOW GRANTS line")
        return MySQLGrant(roles=roles, admin_option=_has_words(words, "WITH", "ADMIN", "OPTION"))
    if any(not re.fullmatch(r"\w+", t) for item in items for t in item):
        raise ValueError("unexpected SHOW GRANTS line")
    privileges = tuple(dict.fromkeys(
        "ALL PRIVILEGES" if p in ("ALL", "ALL PRIVILEGES") else p
        for p in (" ".join(t.upper() for t in item) for item in items)
    ))
    to = words.index("TO") if "TO" in words else len(words)
    on = rest[:to]
    if on and words[0] in ("TABLE", "FUNCTION", "PROCEDURE"):
        on = [words[0] + " ", *on[1:]]
    return MySQLGrant(
        privileges=privileges, on="".join(on) or None,
        grant_option=_has_words(words[to:], "WITH", "GRANT", "OPTION"),
    )


def _has_words(words: list[str], *seq: str) -> bool:
    return any(tuple(words[i:i + len(seq)]) == seq for i in range(len(words)))


def _roles_of(grants: list[MySQLGrant]) -> set[str]:
    return {r for g in grants for r in g.roles}


def mysql_write_privileges(show_grants: Callable[[str], list[str]]) -> list[str]:
    """What lets the login write, from its SHOW GRANTS and those of every role
    granted to it — active or not, since SET ROLE makes one active.
    `show_grants(statement)` answers a SHOW GRANTS statement's lines. MySQL 8
    expands roles with `USING`; MariaDB, which has none, through SHOW GRANTS FOR
    each role. Roles that neither expands leave the login unverified (raises)."""
    grants = [g for line in show_grants("SHOW GRANTS") if (g := parse_mysql_grant(line))]
    expanded: set[str] = set()
    for _ in range(4):
        new = _roles_of(grants) - expanded
        if not new:
            break
        expanded |= new
        try:
            lines = show_grants("SHOW GRANTS FOR CURRENT_USER() USING " + ", ".join(sorted(expanded)))
        except duckdb.Error:
            lines = [line for role in sorted(new) for line in show_grants(f"SHOW GRANTS FOR {role}")]
        grants += [g for line in lines if (g := parse_mysql_grant(line))]
    else:
        if _roles_of(grants) - expanded:
            raise ValueError("roles nested too deep to verify")
    if not grants:
        raise ValueError("SHOW GRANTS answered no grant")
    return list(dict.fromkeys(p for g in grants for p in g.writes))


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

    def show_grants(statement: str) -> list[str]:
        rows = con.execute(f"SELECT * FROM mysql_query('{alias}', {_literal(statement)})").fetchall()
        return [str(row[0]) for row in rows]

    return Verdict("mysql", tuple(mysql_write_privileges(show_grants)), steps=steps)


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
