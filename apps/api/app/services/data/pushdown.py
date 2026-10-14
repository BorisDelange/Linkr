"""Compute pushdown and Arrow Flight: how an app query reaches an external
database as its own SQL (remote_sql), how its large results come back (flight),
and how it is stopped from another request (query_cancel).

The orchestration of db_connect's `query_external` / `materialize_parquet`;
the ATTACH itself stays in db_connect.
"""

import logging
import re
import threading
import time
import uuid
from collections.abc import Callable

import duckdb

from app.services.data import db_connect, flight, query_cancel, remote_sql

logger = logging.getLogger(__name__)

# A scope's columns change only with the remote schema: re-read after this long.
_REMOTE_COLUMNS_TTL = 300.0
_remote_columns_cache: dict[tuple, tuple[float, dict[str, dict[str, str]]]] = {}
_remote_columns_lock = threading.Lock()

# What the audit line keeps of the SQL sent to the database (core/audit _DETAIL_MAX).
_LOGGED_SQL_MAX = 2000


class RemoteQueryFailed(RuntimeError):
    """A pushed-down statement failed while the database ran it. Not a
    duckdb.IOException on purpose: connection_pool takes that for a dead
    connection and runs the query again on a fresh one."""

# Remote type names (information_schema.data_type) as the SQL types remote_sql
# reasons on. Doris suffixes its newer storage formats (datetimev2, decimalv3).
_REMOTE_TYPE_ALIASES = {"string": "TEXT", "largeint": "HUGEINT", "datetime": "TIMESTAMP"}
_REMOTE_TYPE_SUFFIX = re.compile(r"v\d+$")


def _remote_type(data_type: str) -> str:
    name = _REMOTE_TYPE_SUFFIX.sub("", str(data_type).strip().lower())
    return _REMOTE_TYPE_ALIASES.get(name, name.upper())


def _scope_columns(con: duckdb.DuckDBPyConnection, config: dict) -> dict[str, dict[str, str]]:
    """Table → {column: type} of the source's scope, lower-cased, from its own
    information_schema."""
    spec = db_connect._engine_spec(config)
    scope = db_connect._scope(config)
    key = (
        config.get("engine"), config.get("host"), config.get("port"), config.get("database"), scope,
        config.get("username"),
    )
    with _remote_columns_lock:
        hit = _remote_columns_cache.get(key)
    if hit and time.monotonic() - hit[0] < _REMOTE_COLUMNS_TTL:
        return hit[1]
    inner = (
        "SELECT table_name, column_name, data_type FROM information_schema.columns "
        f"WHERE table_schema = ''{scope}''"
    )
    columns: dict[str, dict[str, str]] = {}
    for table, column, data_type in con.execute(
        f"SELECT * FROM {spec['query_fn']}('{db_connect._ATTACH_ALIAS}', '{inner}')"
    ).fetchall():
        columns.setdefault(str(table).lower(), {})[str(column).lower()] = _remote_type(data_type)
    with _remote_columns_lock:
        _remote_columns_cache[key] = (time.monotonic(), columns)
    return columns


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
        return remote_sql.to_remote(
            sql, engine, db_connect._scope(config),
            lambda table: _scope_columns(con, config).get(table.lower()),
        )
    except remote_sql.NotPortable as exc:
        logger.debug("query not pushed down (%s)", exc)
        return None


def _renamed(source: str, remote: remote_sql.RemoteQuery) -> str:
    names = ", ".join('"' + n.replace('"', '""') + '"' for n in remote.columns)
    return f"SELECT * FROM {source} AS _remote({names})"


def _passthrough(config: dict, remote: remote_sql.RemoteQuery) -> str:
    literal = remote.sql.replace("'", "''")
    return _renamed(f"{db_connect._engine_spec(config)['query_fn']}('{db_connect._ATTACH_ALIAS}', '{literal}')", remote)


def _flight_probe(con: duckdb.DuckDBPyConnection, config: dict) -> str | None:
    """One row of a table of the scope, in the engine's SQL (see flight.problem)."""
    tables = sorted(_scope_columns(con, config))
    if not tables:
        return None

    def quote(name: str) -> str:
        return "`" + name.replace("`", "``") + "`"

    return f"SELECT 1 AS one FROM {quote(db_connect._scope(config))}.{quote(tables[0])} LIMIT 1"


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
                raise RemoteQueryFailed(str(exc)) from exc
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
            return _run_over_flight(con, config, password, remote, run)
        except flight.Unreachable as exc:
            flight.record(config, (exc.status, str(exc)[:300]))
    query_fn = db_connect._engine_spec(config)["query_fn"]
    connection_id = con.execute(
        f"SELECT * FROM {query_fn}('{db_connect._ATTACH_ALIAS}', 'SELECT CONNECTION_ID() AS id')"
    ).fetchone()[0]
    kill = _RemoteKill(config, password, int(connection_id))
    try:
        with query_cancel.on_cancel(kill):
            return run(_passthrough(config, remote))
    except duckdb.IOException as exc:
        if kill.fired:
            raise duckdb.InterruptException("query cancelled") from exc
        if _REMOTE_PREPARE_FAILED not in str(exc):
            raise RemoteQueryFailed(str(exc)) from exc
        logger.warning("pushed-down query refused by the database, ran it locally: %s", exc)
        return run(sql)
    finally:
        kill.done = True
