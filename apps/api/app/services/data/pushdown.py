"""Compute pushdown and Arrow Flight: how an app query reaches an external
database as its own SQL (remote_sql), how its large results come back (flight),
and how it is stopped from another request (query_cancel).

The orchestration of db_connect's `query_external` / `materialize_parquet`;
the ATTACH itself stays in db_connect.
"""

import contextvars
import logging
import re
import threading
import time
import uuid
from collections.abc import Callable

import duckdb

from app.services.data import db_connect, flight, query_cancel, remote_sql

logger = logging.getLogger(__name__)

# The remote catalogue changes only with the remote schema: re-read after this long.
_REMOTE_COLUMNS_TTL = 300.0
_remote_columns_cache: dict[tuple, tuple[float, dict[tuple[str, str], remote_sql.RemoteTable]]] = {}
_remote_columns_lock = threading.Lock()

# What the audit line keeps of the SQL sent to the database (core/audit _DETAIL_MAX).
_LOGGED_SQL_MAX = 2000

# sqlglot underlines the token it stopped at with terminal escapes.
_ANSI = re.compile(r"\x1b\[[0-9;]*m")


# How the request's query ran, for the SQL console to say: `computedBy` is
# "database" (pushed down, or native) or "linkr" (DuckDB over the ATTACH), with
# the `reason` it was not pushed down. The request installs the dict; the worker
# thread fills it — asyncio.to_thread copies the context, not the dict.
execution: contextvars.ContextVar[dict | None] = contextvars.ContextVar("pushdown_execution", default=None)


def _record(computed_by: str, reason: str | None = None) -> None:
    holder = execution.get()
    if holder is not None:
        holder.clear()
        holder.update(computedBy=computed_by, reason=reason)


class RemoteQueryFailed(RuntimeError):
    """A pushed-down statement failed while the database ran it. Not a
    duckdb.IOException on purpose: connection_pool takes that for a dead
    connection and runs the query again on a fresh one."""


# The mysql extension quotes the whole statement into its error, and DuckDB then
# adds the passthrough call it came from: tens of KB around a one-line reason.
_DUCKDB_CONTEXT = re.compile(r"\n+LINE \d+:.*", re.S)


def _database_error(exc: Exception, sql: str) -> str:
    """The database's reason for failing `sql`, without the echoed statement."""
    message = str(exc).replace(f' "{sql}"', "", 1)
    return _DUCKDB_CONTEXT.sub("", message).strip()

# Remote type names (information_schema.data_type) as the SQL types remote_sql
# reasons on. Doris suffixes its newer storage formats (datetimev2, decimalv3).
_REMOTE_TYPE_ALIASES = {"string": "TEXT", "largeint": "HUGEINT", "datetime": "TIMESTAMP"}
_REMOTE_TYPE_SUFFIX = re.compile(r"v\d+$")


def _remote_type(data_type: str) -> str:
    name = _REMOTE_TYPE_SUFFIX.sub("", str(data_type).strip().lower())
    return _REMOTE_TYPE_ALIASES.get(name, name.upper())


def _remote_tables(con: duckdb.DuckDBPyConnection, config: dict) -> dict[tuple[str, str], remote_sql.RemoteTable]:
    """`(schema, table)` lower-cased → the table, for every data schema the login
    reads, from the database's own information_schema."""
    spec = db_connect._engine_spec(config)
    key = (
        config.get("engine"), config.get("host"), config.get("port"), config.get("database"),
        config.get("username"),
    )
    with _remote_columns_lock:
        hit = _remote_columns_cache.get(key)
    if hit and time.monotonic() - hit[0] < _REMOTE_COLUMNS_TTL:
        return hit[1]
    inner = (
        "SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns "
        f"WHERE table_schema NOT IN ({db_connect._SYSTEM_SCHEMAS_NESTED})"
    )
    tables: dict[tuple[str, str], remote_sql.RemoteTable] = {}
    for schema, table, column, data_type in con.execute(
        f"SELECT * FROM {spec['query_fn']}('{db_connect._ATTACH_ALIAS}', '{inner}')"
    ).fetchall():
        if db_connect.is_system_schema(str(schema)):
            continue
        ref = (str(schema).lower(), str(table).lower())
        if ref not in tables:
            tables[ref] = remote_sql.RemoteTable(str(schema), str(table), {})
        tables[ref].columns[str(column).lower()] = _remote_type(data_type)
    with _remote_columns_lock:
        _remote_columns_cache[key] = (time.monotonic(), tables)
    return tables


def _table_lookup(con: duckdb.DuckDBPyConnection, config: dict) -> remote_sql.TableLookup:
    default = db_connect._scope(config)

    def lookup(schema: str | None, table: str) -> remote_sql.RemoteTable | None:
        schema = schema or default
        if schema is None:
            return None
        return _remote_tables(con, config).get((schema.lower(), table.lower()))

    return lookup


# How the mysql extension reports a statement the server rejected before running
# it (its prepare step), as opposed to one that failed while running.
_REMOTE_PREPARE_FAILED = "Failed to prepare MySQL query"


def _pushed_down(con: duckdb.DuckDBPyConnection, config: dict, sql: str) -> remote_sql.RemoteQuery | None:
    """`sql` in the external database's own SQL, or None when it is not portable
    (remote_sql) — the caller then runs it as is."""
    engine = config.get("engine")
    if engine not in remote_sql.PUSHDOWN_ENGINES:
        return None
    try:
        return remote_sql.to_remote(sql, engine, _table_lookup(con, config))
    except remote_sql.NotPortable as exc:
        logger.info("query not pushed down (%s)", exc)
        _record("linkr", _ANSI.sub("", str(exc)).splitlines()[0])
        return None


def _renamed(source: str, remote: remote_sql.RemoteQuery) -> str:
    names = ", ".join('"' + n.replace('"', '""') + '"' for n in remote.columns)
    return f"SELECT * FROM {source} AS _remote({names})"


def _passthrough(config: dict, remote: remote_sql.RemoteQuery) -> str:
    literal = remote.sql.replace("'", "''")
    return _renamed(f"{db_connect._engine_spec(config)['query_fn']}('{db_connect._ATTACH_ALIAS}', '{literal}')", remote)


def _flight_probe(con: duckdb.DuckDBPyConnection, config: dict) -> str | None:
    """One row of a table of the database, in the engine's SQL (see flight.problem).
    A table of the default schema when it has one."""
    tables = sorted(_remote_tables(con, config).items())
    if not tables:
        return None
    default = (db_connect._scope(config) or "").lower()
    table = next((t for (schema, _), t in tables if schema == default), tables[0][1])

    def quote(name: str) -> str:
        return "`" + name.replace("`", "``") + "`"

    return f"SELECT 1 AS one FROM {quote(table.schema)}.{quote(table.name)} LIMIT 1"


def flight_problem(config: dict, password: str | None) -> tuple[str, str | None] | None:
    """Why Flight cannot carry this source's large results, or None (see flight)."""
    if flight.port(config) is None:
        return None
    con = db_connect._connect(db_connect._engine_spec(config)["extension"])
    try:
        db_connect._attach(con, config, password)
        return flight.problem(config, password, _flight_probe(con, config))
    finally:
        con.close()


def _run_over_flight(
    con: duckdb.DuckDBPyConnection, config: dict, password: str | None,
    remote: remote_sql.RemoteQuery, run: Callable[[str], object],
):
    """`run` over the result streamed by Flight, registered as a view of `con`.
    Raises flight.Unreachable when the transport fails before any row is read,
    RemoteQueryFailed when the database failed the statement."""
    view = f"_flight_{uuid.uuid4().hex}"
    cancelled: list[bool] = []
    with flight.reader(config, password, remote.sql) as (batches, cancel):
        con.register(view, batches)
        try:
            with query_cancel.on_cancel(lambda: (cancelled.append(True), cancel())):
                return run(_renamed(f'"{view}"', remote))
        except duckdb.Error as exc:
            if cancelled:
                raise duckdb.InterruptException("query cancelled") from exc
            if flight.is_transport_error(exc):
                raise flight.Unreachable(str(exc).splitlines()[0], flight.status_of(exc)) from exc
            if isinstance(exc, duckdb.IOException):
                raise RemoteQueryFailed(_database_error(exc, remote.sql)) from exc
            raise
        finally:
            con.unregister(view)


class _RemoteKill:
    """Stops a pushed-down statement on the database's side, from a connection of
    its own: the one running it is busy, and DuckDB's interrupt only takes effect
    once the remote statement returns."""

    def __init__(self, config: dict, password: str | None, connection_id: int):
        self.config, self.password, self.connection_id = config, password, connection_id
        self.fired = False
        self.done = False

    def __call__(self) -> None:
        self.fired = True
        threading.Thread(target=self._kill, daemon=True).start()

    def _kill(self) -> None:
        if self.done:
            return
        try:
            con = db_connect._connect(db_connect._engine_spec(self.config)["extension"])
            try:
                db_connect._attach(con, self.config, self.password)
                con.execute(f"CALL mysql_execute('{db_connect._ATTACH_ALIAS}', 'KILL QUERY {self.connection_id}')")
            finally:
                con.close()
        except Exception as exc:  # the statement then runs to its end, as before
            logger.warning("could not stop a pushed-down query on the database: %s", exc)


def _with_pushdown(
    con: duckdb.DuckDBPyConnection, config: dict, password: str | None, sql: str,
    run: Callable[[str], object], bulk: bool = False,
):
    """`run` the pushed-down form of `sql` when there is one, else `sql`. A `bulk`
    result goes over Arrow Flight when the database offers it (flight).

    A query the database refuses to prepare (a function or type it does not
    know) falls back to the ATTACH: slower, same answer. One that failed while
    running (out of memory, timed out) raises RemoteQueryFailed and is not
    retried that way — by this function or by the connection pool — since the
    ATTACH would pull every row the database could not even aggregate."""
    remote = _pushed_down(con, config, sql)
    if remote is None:
        return run(sql)
    logger.info("pushed down to %s: %s", config.get("host"), remote.sql[:_LOGGED_SQL_MAX])
    if bulk and flight.port(config) is not None and flight.problem(config, password, _flight_probe(con, config)) is None:
        try:
            result = _run_over_flight(con, config, password, remote, run)
            _record("database")
            return result
        except flight.Unreachable as exc:
            flight.record(config, (exc.status, str(exc)[:300]))
    try:
        result = _run_killable(con, config, password, _passthrough(config, remote), run)
    except duckdb.IOException as exc:
        reason = _database_error(exc, remote.sql)
        if _REMOTE_PREPARE_FAILED not in reason:
            raise RemoteQueryFailed(reason) from exc
        logger.warning("pushed-down query refused by the database, ran it locally: %s", reason)
        _record("linkr", f"refused by the database: {reason.splitlines()[0]}")
        return run(sql)
    _record("database")
    return result


def plan(con, config: dict, sql: str) -> None:
    """Records who would compute `sql` — the database or Linkr (`execution`) —
    without running it: what a caller weighs before a query that would read the
    database's tables whole. `con` is only read when the database's columns are
    not cached."""
    if _pushed_down(con, config, sql) is not None:
        _record("database")


class _AttachedOnUse:
    """A connection opened and attached on its first statement, if any."""

    def __init__(self, setup: Callable[[], duckdb.DuckDBPyConnection]):
        self._setup, self._con = setup, None

    def execute(self, *args):
        if self._con is None:
            self._con = self._setup()
        return self._con.execute(*args)

    def close(self) -> None:
        if self._con is not None:
            self._con.close()


def plan_external(config: dict, password: str | None, sql: str) -> None:
    """Who would compute `sql` (`plan`), without running it — and off the
    pooled connection, which a long query may hold: a connection of its own,
    opened only when the database's columns are not cached."""
    spec = db_connect._engine_spec(config)

    def setup() -> duckdb.DuckDBPyConnection:
        con = db_connect._connect(spec["extension"])
        db_connect._attach(con, config, password)
        return con

    con = _AttachedOnUse(setup)
    try:
        plan(con, config, sql)
    finally:
        con.close()


class NativeRefused(ValueError):
    """Native SQL that is not one plain read of the database."""


# Doris table functions that read files or other systems with the login's rights.
_NATIVE_TABLE_FUNCTIONS = re.compile(r"\b(s3|hdfs|local|http_stream|query)\s*\(", re.IGNORECASE)
_NATIVE_START = re.compile(r"\s*\(*\s*(select|with)\b", re.IGNORECASE)


def _native_code(sql: str) -> str:
    """`sql` with every string literal emptied and every comment blanked, as
    Doris' lexer reads them (strings with backslash escapes and doubled quotes,
    backtick identifiers, `--` and nested `/* */` comments). What Doris might
    read otherwise is refused, since text taken for a comment here would run
    there: a `#`, a backslash in a `--` comment, a `/*` inside a comment, an
    unterminated string. A hint `/*+ … */` is lexed by Doris as SQL, so it is
    kept as SQL."""
    out: list[str] = []
    i, n = 0, len(sql)
    while i < n:
        c = sql[i]
        if c in "'\"`":
            j = i + 1
            while True:
                if j >= n:
                    raise NativeRefused("native SQL: unterminated quote")
                if sql[j] == "\\" and c != "`":
                    j += 2
                    continue
                if sql[j] == c:
                    if j + 1 < n and sql[j + 1] == c:
                        j += 2
                        continue
                    break
                j += 1
            out.append(c + c)
            i = j + 1
        elif sql.startswith("--", i):
            end = sql.find("\n", i)
            end = n if end < 0 else end
            if "\\" in sql[i:end]:
                raise NativeRefused("native SQL: a backslash in a comment")
            out.append(" ")
            i = end
        elif sql.startswith("/*+", i):
            out.append(" ")
            i += 3
        elif sql.startswith("/*", i):
            end = sql.find("*/", i + 2)
            if end < 0 or "/*" in sql[i + 2:end]:
                raise NativeRefused("native SQL: an unterminated or nested comment")
            out.append(" ")
            i = end + 2
        elif c == "#":
            raise NativeRefused("native SQL: '#' outside a string")
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _native_statement(sql: str) -> str:
    """`sql` without its trailing `;`, when it is one SELECT (or WITH … SELECT)
    that leaves nothing behind: no second statement, no `INTO` (OUTFILE, a
    variable), no `:=`, no table function reading outside the database. A
    SET or USE would outlive the query on the pooled connection."""
    statement = sql.strip()
    while statement.endswith(";"):
        statement = statement[:-1].rstrip()
    code = _native_code(statement)
    if not _NATIVE_START.match(code):
        raise NativeRefused("native SQL must be a single SELECT")
    if ";" in code:
        raise NativeRefused("native SQL must be a single statement")
    if re.search(r"\binto\b", code, re.IGNORECASE):
        raise NativeRefused("native SQL cannot write: INTO is refused")
    if ":=" in code:
        raise NativeRefused("native SQL cannot set a variable")
    found = _NATIVE_TABLE_FUNCTIONS.search(code)
    if found:
        raise NativeRefused(f"native SQL cannot read outside the database: {found.group(1)}()")
    return statement


def run_native(
    con: duckdb.DuckDBPyConnection, config: dict, password: str | None, sql: str,
    run: Callable[[str], object],
):
    """`sql` in the database's own dialect, sent as written — the SQL console's
    native mode, for what DuckDB cannot spell (Doris' `MATCH_ANY` on an inverted
    index). The login is read-only (db_connect._require_read_only_doris_login);
    on top of that only one plain SELECT is sent (`_native_statement`). An error
    is the database's own."""
    statement = _native_statement(sql)
    literal = statement.replace("'", "''")
    passthrough = f"SELECT * FROM {db_connect._engine_spec(config)['query_fn']}('{db_connect._ATTACH_ALIAS}', '{literal}')"
    logger.info("native query on %s: %s", config.get("host"), sql[:_LOGGED_SQL_MAX])
    _record("database")
    try:
        return _run_killable(con, config, password, passthrough, run)
    except duckdb.IOException as exc:
        raise RemoteQueryFailed(_database_error(exc, statement)) from exc


def _run_killable(
    con: duckdb.DuckDBPyConnection, config: dict, password: str | None, passthrough: str,
    run: Callable[[str], object],
):
    """`run` a passthrough statement, stopped on the database's side when the
    query is cancelled (_RemoteKill)."""
    query_fn = db_connect._engine_spec(config)["query_fn"]
    connection_id = con.execute(
        f"SELECT * FROM {query_fn}('{db_connect._ATTACH_ALIAS}', 'SELECT CONNECTION_ID() AS id')"
    ).fetchone()[0]
    kill = _RemoteKill(config, password, int(connection_id))
    try:
        with query_cancel.on_cancel(kill):
            return run(passthrough)
    except duckdb.IOException as exc:
        if kill.fired:
            raise duckdb.InterruptException("query cancelled") from exc
        raise
    finally:
        kill.done = True
