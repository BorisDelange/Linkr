"""Oracle through its own Python driver, python-oracledb (thin mode: pure Python,
no Oracle Client): how an app query that remote_sql spelled in Oracle's SQL is
run by Oracle itself, its rows coming back as Arrow.

The DuckDB extension (community_engines) stays what every other path attaches;
it reads tables whole. This is the fast path of `pushdown` for Oracle, as Doris'
passthrough is for Doris.

Every session is pinned to what DuckDB assumes, so that a pushed-down query
answers as DuckDB would: ISO date formats, `.` as decimal separator, binary
(code point) ordering and comparison. Each query runs in a READ ONLY
transaction, on top of the read-only login community_engines requires.
"""

from __future__ import annotations

import hashlib
import threading
from collections.abc import Iterator
from contextlib import contextmanager

import pyarrow as pa

try:
    import oracledb
except ImportError:  # pragma: no cover - the dependency is declared in pyproject
    oracledb = None

from app.services.data import community_engines
from app.services.data.db_host_guard import check_db_host

_SESSION = (
    "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS' "
    "NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF6' NLS_NUMERIC_CHARACTERS = '.,' "
    "NLS_SORT = BINARY NLS_COMP = BINARY TIME_ZONE = '+00:00'"
)

# Compile errors outside ORA-009xx: union of incompatible types, EXTRACT of a
# missing field, a LOB where Oracle compares or groups.
_REFUSED = {"ORA-01790", "ORA-30076", "ORA-22849", "ORA-00932", "ORA-00937", "ORA-00979"}

_pools: dict[str, oracledb.ConnectionPool] = {}
_pools_lock = threading.Lock()


class OracleQueryFailed(RuntimeError):
    """Oracle refused or failed the statement; the message is Oracle's own."""

    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        self.code = code

    @property
    def refused(self) -> bool:
        """Oracle could not compile the statement (a name, a type, a clause it does
        not take): nothing ran, and the query can run elsewhere. ORA-009xx are its
        parse and name errors."""
        return bool(self.code) and (self.code.startswith("ORA-009") or self.code in _REFUSED)


class OracleCancelled(RuntimeError):
    """The statement was stopped by `cancel` (the user's Stop)."""


def _dsn(config: dict) -> str:
    check_db_host(config.get("host"))
    port = int(config.get("port") or community_engines.DEFAULT_PORTS["oracle"])
    return f"{config.get('host')}:{port}/{config.get('database') or ''}"


def _init_session(connection, _tag) -> None:
    with connection.cursor() as cur:
        cur.execute(_SESSION)


def _pool(config: dict, password: str | None) -> oracledb.ConnectionPool:
    if oracledb is None:
        raise OracleQueryFailed("the python-oracledb driver is not installed on this server")
    dsn = _dsn(config)
    # Keyed by the password's hash too: a user whose password changed gets a new pool.
    key = hashlib.sha256(f"{dsn}\0{config.get('username')}\0{password}".encode()).hexdigest()
    with _pools_lock:
        pool = _pools.get(key)
        if pool is None:
            pool = oracledb.create_pool(
                user=config.get("username"), password=password or "", dsn=dsn,
                min=0, max=4, increment=1, session_callback=_init_session,
            )
            _pools[key] = pool
    return pool


@contextmanager
def _connection(config: dict, password: str | None) -> Iterator[oracledb.Connection]:
    connection = _pool(config, password).acquire()
    try:
        yield connection
    finally:
        try:
            connection.rollback()
        finally:
            connection.close()


def _rows(connection: oracledb.Connection, sql: str, max_rows: int | None, exact: bool) -> pa.Table:
    if max_rows is None:
        return pa.table(connection.fetch_df_all(sql, arraysize=10_000, fetch_decimals=exact))
    batches: list[pa.Table] = []
    kept = 0
    for frame in connection.fetch_df_batches(sql, size=min(max_rows, 10_000) or 1, fetch_decimals=exact):
        batches.append(pa.table(frame))
        kept += batches[-1].num_rows
        if kept >= max_rows:
            break
    # An empty result is still one batch, which carries the columns.
    return pa.concat_tables(batches).slice(0, max_rows)


def _integers(table: pa.Table) -> pa.Table:
    """Each NUMBER(p, 0) column (an id, a count stored as such) as a 64-bit
    integer, unless a value does not fit one."""
    for i, field in enumerate(table.schema):
        if pa.types.is_decimal(field.type) and field.type.scale == 0:
            try:
                table = table.set_column(i, field.name, table.column(i).cast(pa.int64()))
            except pa.ArrowInvalid:
                pass
    return table


def fetch_arrow(
    config: dict, password: str | None, sql: str, on_cancel=None, max_rows: int | None = None,
    exact: bool = False,
) -> pa.Table:
    """Run `sql` (Oracle's SQL, one SELECT) in a READ ONLY transaction and return
    its rows as Arrow, the first `max_rows` of them when given (the rest is never
    fetched). A NUMBER comes as a double, or with `exact` as what its declared
    precision holds (an integer, a decimal). `on_cancel(stop)` registers the
    function that stops it."""
    with _connection(config, password) as connection:
        cancelled: list[bool] = []

        def stop() -> None:
            cancelled.append(True)
            connection.cancel()

        if on_cancel is not None:
            on_cancel(stop)
        try:
            with connection.cursor() as cur:
                cur.execute("SET TRANSACTION READ ONLY")
            table = _rows(connection, sql, max_rows, exact)
            return _integers(table) if exact else table
        except oracledb.Error as exc:
            if cancelled:
                raise OracleCancelled("query cancelled") from exc
            error = exc.args[0] if exc.args else None
            raise OracleQueryFailed(str(exc).splitlines()[0], getattr(error, "full_code", None)) from exc


def columns(config: dict, password: str | None, schema: str | None) -> list[tuple]:
    """(owner, table, column, data type, precision, scale) of every column of the
    schema read (`schema`, else the login's own), in order."""
    owner = ":owner" if schema else "USER"
    sql = (
        "SELECT owner, table_name, column_name, data_type, data_precision, data_scale "
        f"FROM all_tab_columns WHERE owner = {owner} ORDER BY table_name, column_id"
    )
    with _connection(config, password) as connection, connection.cursor() as cur:
        cur.execute(sql, {"owner": schema.upper()} if schema else {})
        return cur.fetchall()
