"""Arrow Flight SQL: how a large pushed-down result leaves an external database.

The MySQL protocol turns Doris' columns into text rows that DuckDB turns back
into columns: 100 s for 3.4 M rows, against 2.6 s over Flight SQL, which streams
the columns as they are (docs/planning/doris-plan.md §1.3). Only worth it when
many rows come back, so only for the bulk paths (db_connect `bulk`).

Optional: the driver is the `doris` extra. Without it, or when Flight cannot be
reached, the query goes over the MySQL protocol as before — slower, same rows —
and `problem` says why, which the database page shows.

Doris answers a Flight query from its backends, not from the frontend the
client connects to: each backend must be reachable from this server, or
announce an address that is (`public_host` + `arrow_flight_sql_proxy_port`).
"""

from __future__ import annotations

import contextlib
import logging
import threading
import time
from collections.abc import Callable, Iterator

logger = logging.getLogger(__name__)

try:
    import adbc_driver_flightsql.dbapi as _flightsql
except ImportError:  # the `doris` extra is not installed
    _flightsql = None

DEFAULT_PORTS = {"doris": 8070}

NOT_INSTALLED = "not_installed"
UNREACHABLE = "unreachable"

# A failed probe is believed this long before Flight is tried again.
_RECHECK_AFTER = 600.0
# The probe must not hold a request for the 20 s a gRPC dial waits by default.
_PROBE_TIMEOUT = "5"

_lock = threading.Lock()
_checked: dict[tuple, tuple[float, str | None, str | None]] = {}


class Unreachable(Exception):
    """Flight could not carry the query; the MySQL protocol can."""


def port(config: dict) -> int | None:
    engine = config.get("engine")
    if engine not in DEFAULT_PORTS:
        return None
    return int(config.get("flightPort") or DEFAULT_PORTS[engine])


def _key(config: dict) -> tuple:
    return (config.get("engine"), config.get("host"), port(config), config.get("username"))


def _connect(config: dict, password: str | None, timeout: str | None = None):
    kwargs = {"username": config.get("username") or "", "password": password or ""}
    if timeout:
        kwargs["adbc.flight.sql.rpc.timeout_seconds.query"] = timeout
        kwargs["adbc.flight.sql.rpc.timeout_seconds.fetch"] = timeout
    return _flightsql.connect(f"grpc://{config['host']}:{port(config)}", db_kwargs=kwargs)


def _is_transport_error(exc: Exception) -> bool:
    text = str(exc)
    return any(s in text for s in ("Unavailable", "connection error", "DeadlineExceeded", "dial tcp", "Unauthenticated"))


def problem(config: dict, password: str | None, probe_sql: str | None) -> tuple[str, str | None] | None:
    """None when Flight can carry this source's results; else (reason, detail).

    `probe_sql` reads one row of a real table: Doris serves a constant from its
    frontend, so only a table read proves the backends are reachable."""
    if port(config) is None:
        return None
    if _flightsql is None:
        return NOT_INSTALLED, None
    key = _key(config)
    with _lock:
        hit = _checked.get(key)
    if hit and (hit[1] is None or time.monotonic() - hit[0] < _RECHECK_AFTER):
        return None if hit[1] is None else (hit[1], hit[2])
    found: tuple[str, str | None] | None = None
    if probe_sql:
        try:
            with contextlib.closing(_connect(config, password, _PROBE_TIMEOUT)) as conn, conn.cursor() as cur:
                cur.execute(probe_sql)
                cur.fetchall()
        except Exception as exc:  # noqa: BLE001 — any failure means: use the MySQL protocol
            found = (UNREACHABLE, str(exc).splitlines()[0][:300])
    record(config, found)
    return found


def record(config: dict, found: tuple[str, str | None] | None) -> None:
    if found is not None:
        logger.warning("Arrow Flight unavailable for %s:%s (%s); large results go over the MySQL protocol", config.get("host"), port(config), found[1])
    with _lock:
        _checked[_key(config)] = (time.monotonic(), found[0] if found else None, found[1] if found else None)


@contextlib.contextmanager
def reader(config: dict, password: str | None, sql: str) -> Iterator[tuple[object, Callable[[], None]]]:
    """A RecordBatchReader over `sql` (the engine's own SQL), and a cancel that
    stops it on the server. Raises Unreachable when the transport fails."""
    conn = None
    try:
        conn = _connect(config, password)
        cur = conn.cursor()
        cur.execute(sql)
        batches = cur.fetch_record_batch()
    except Exception as exc:
        if conn is not None:
            with contextlib.suppress(Exception):
                conn.close()
        if _is_transport_error(exc):
            raise Unreachable(str(exc).splitlines()[0]) from exc
        raise
    try:
        yield batches, cur.adbc_cancel
    finally:
        with contextlib.suppress(Exception):
            cur.close()
        with contextlib.suppress(Exception):
            conn.close()


def is_transport_error(exc: Exception) -> bool:
    return _flightsql is not None and _is_transport_error(exc)
