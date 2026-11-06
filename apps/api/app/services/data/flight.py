"""Arrow Flight SQL: how a large pushed-down result leaves an external database.

The MySQL protocol turns Doris' columns into text rows that DuckDB turns back
into columns: 100 s for 3.4 M rows, against 2.6 s over Flight SQL, which streams
the columns as they are (docs/planning/doris-plan.md §1.3). Only worth it when
many rows come back, so only for the bulk paths (db_connect `bulk`).

When Flight cannot be reached, the query goes over the MySQL protocol as before —
slower, same rows — and `problem` says why, which the database page shows.

Doris answers a Flight query from its backends, not from the frontend the
client connects to: each backend must be reachable from this server, or
announce an address that is (`public_host` + `arrow_flight_sql_proxy_port`).
Those addresses are the server's word, and the login's token and the rows go to
them, so this client asks for the endpoints itself and follows one only when its
host passes the database host allowlist and, for a source that requires TLS, its
scheme is TLS — which a Flight SQL driver, following them on its own, cannot promise.

TLS follows the source's `sslmode`, with libpq's meaning of the words: `require`
encrypts and trusts the network for the server's identity, `verify-ca` /
`verify-full` check its certificate — against `sslrootcert` (a PEM file on
this server) when given, else the system's roots.
"""

from __future__ import annotations

import contextlib
import logging
import os
import stat
import threading
import time
from collections.abc import Callable, Iterator
from urllib.parse import urlsplit

import pyarrow as pa

from app.services.data.db_host_guard import DbHostNotAllowed, check_db_host

logger = logging.getLogger(__name__)

try:
    import pyarrow.flight as _fl
except ImportError:
    _fl = None

DEFAULT_PORTS = {"doris": 8070}

NOT_INSTALLED = "not_installed"
UNREACHABLE = "unreachable"
UNAUTHENTICATED = "unauthenticated"

_TLS_MODES = ("require", "verify-ca", "verify-full")
# A failed probe is believed this long before Flight is tried again.
_RECHECK_AFTER = 600.0
# The probe must not hold a request for the 20 s a gRPC dial waits by default.
_PROBE_TIMEOUT = 5.0
# Far above any CA bundle a source would name.
_ROOT_CERT_MAX = 1 << 20
_BAD_ROOT_CERT = "The CA file named by sslrootcert cannot be used"
# How Flight says "fetch it over the connection you already hold".
_REUSE_CONNECTION = "arrow-flight-reuse-connection"
_PLAIN_SCHEMES = ("grpc", "grpc+tcp")
_TLS_SCHEME = "grpc+tls"

_lock = threading.Lock()
_checked: dict[tuple, tuple[float, str | None, str | None]] = {}


class Unreachable(Exception):
    """Flight could not carry the query; the MySQL protocol can. `status` says
    whether the port did not answer (UNREACHABLE) or refused the login."""

    def __init__(self, message: str, status: str = UNREACHABLE):
        super().__init__(message)
        self.status = status


def port(config: dict) -> int | None:
    engine = config.get("engine")
    if engine not in DEFAULT_PORTS:
        return None
    return int(config.get("flightPort") or DEFAULT_PORTS[engine])


def tls(config: dict) -> bool:
    return str(config.get("sslmode") or "").lower() in _TLS_MODES


def uri(config: dict) -> str:
    scheme = "grpc+tls" if tls(config) else "grpc"
    return f"{scheme}://{config['host']}:{port(config)}"


def _key(config: dict) -> tuple:
    return (config.get("engine"), config.get("host"), port(config), config.get("username"), tls(config))


def _read_root_cert(path: object) -> bytes:
    """The PEM at `path`. A source's connection config names it: whatever it names,
    the read ends, and the refusal does not tell what is on the server's disk."""
    try:
        fd = os.open(str(path), os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    except (OSError, ValueError) as exc:
        raise Unreachable(_BAD_ROOT_CERT) from exc
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise Unreachable(_BAD_ROOT_CERT)
        pem = os.read(fd, _ROOT_CERT_MAX + 1)
    except OSError as exc:
        raise Unreachable(_BAD_ROOT_CERT) from exc
    finally:
        os.close(fd)
    if len(pem) > _ROOT_CERT_MAX or b"-----BEGIN CERTIFICATE-----" not in pem:
        raise Unreachable(_BAD_ROOT_CERT)
    return pem


def _tls_options(config: dict) -> dict:
    if not tls(config):
        return {}
    options: dict = {}
    if str(config.get("sslmode")).lower() == "require":
        options["disable_server_verification"] = True
    if root_cert := config.get("sslrootcert"):
        options["tls_root_certs"] = _read_root_cert(root_cert)
    return options


def _client(location: str, options: dict):
    return _fl.FlightClient(location, **options)


def _checked_host(host: str | None) -> None:
    try:
        check_db_host(host)
    except DbHostNotAllowed as exc:
        raise Unreachable(str(exc)) from exc


def _checked_location(config: dict, location: bytes | str) -> str | None:
    """The address to read an endpoint from, None for the connection already open.
    Raises Unreachable when this source may not follow it."""
    uri = location.decode("utf-8", "replace") if isinstance(location, bytes) else str(location)
    parts = urlsplit(uri)
    if parts.scheme == _REUSE_CONNECTION:
        return None
    allowed = (_TLS_SCHEME,) if tls(config) else (_TLS_SCHEME, *_PLAIN_SCHEMES)
    if parts.scheme not in allowed or not parts.hostname:
        raise Unreachable(f"the database announced a backend that is not allowed: {uri[:200]}")
    _checked_host(parts.hostname)
    return uri


def _length_prefixed(field: int, payload: bytes) -> bytes:
    size = bytearray()
    length = len(payload)
    while length > 0x7F:
        size.append(length & 0x7F | 0x80)
        length >>= 7
    size.append(length)
    return bytes([field << 3 | 2]) + bytes(size) + payload


def _statement_command(sql: str) -> bytes:
    """Flight SQL's CommandStatementQuery{query = 1}, in a protobuf Any{type_url = 1, value = 2}."""
    return _length_prefixed(1, b"type.googleapis.com/arrow.flight.protocol.sql.CommandStatementQuery") + _length_prefixed(
        2, _length_prefixed(1, sql.encode("utf-8"))
    )


class _Session:
    """One login to the frontend, and the backends its answers were allowed to name."""

    def __init__(self, config: dict, password: str | None, timeout: float | None = None):
        self.config = config
        self.tls_options = _tls_options(config)
        self.clients: dict[str, object] = {}
        self.stream = None
        self.cancelled = False
        _checked_host(config.get("host"))
        self.frontend = self._open(uri(config))
        token = self.frontend.authenticate_basic_token(
            config.get("username") or "", password or "", _fl.FlightCallOptions(timeout=timeout),
        )
        self.call_options = _fl.FlightCallOptions(timeout=timeout, headers=[token])

    def _open(self, location: str):
        if location not in self.clients:
            self.clients[location] = _client(location, self.tls_options)
        return self.clients[location]

    def read(self, sql: str):
        """A RecordBatchReader over `sql`. Every endpoint is checked before the first
        is read: nothing goes to any backend when one of them is refused."""
        info = self.frontend.get_flight_info(_fl.FlightDescriptor.for_command(_statement_command(sql)), self.call_options)
        endpoints = []
        for endpoint in info.endpoints:
            locations = [_checked_location(self.config, location.uri) for location in endpoint.locations]
            endpoints.append((endpoint.ticket, self._open(locations[0]) if locations and locations[0] else self.frontend))
        if not endpoints:
            return pa.RecordBatchReader.from_batches(info.schema, [])
        first = self._get(*endpoints[0])
        return pa.RecordBatchReader.from_batches(first.schema, self._batches(first, endpoints[1:]))

    def _get(self, ticket, client):
        self.stream = client.do_get(ticket, self.call_options)
        return self.stream

    def _batches(self, stream, remaining: list) -> Iterator:
        while True:
            try:
                chunk = stream.read_chunk()
            except StopIteration:
                if self.cancelled or not remaining:
                    return
                stream = self._get(*remaining.pop(0))
                continue
            if chunk.data is not None:
                yield chunk.data

    def cancel(self) -> None:
        self.cancelled = True
        if self.stream is not None:
            self.stream.cancel()

    def close(self) -> None:
        for client in self.clients.values():
            with contextlib.suppress(Exception):
                client.close()


_TRANSPORT_MARKERS = (
    "unavailable", "connection error", "deadlineexceeded", "deadline exceeded", "timeout error",
    "failed to connect", "dial tcp", "unauthenticated",
)


def _is_transport_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(marker in text for marker in _TRANSPORT_MARKERS) or isinstance(
        exc, (_fl.FlightUnavailableError, _fl.FlightTimedOutError, _fl.FlightUnauthenticatedError)
    )


def status_of(exc: Exception) -> str:
    """What a failed Flight call says about the port: refused the login, or did
    not answer (the default, which also covers a backend out of reach)."""
    if isinstance(exc, Unreachable):
        return exc.status
    refused = isinstance(exc, _fl.FlightUnauthenticatedError) if _fl else False
    return UNAUTHENTICATED if refused or "unauthenticated" in str(exc).lower() else UNREACHABLE


def problem(config: dict, password: str | None, probe_sql: str | None) -> tuple[str, str | None] | None:
    """None when Flight can carry this source's results; else (reason, detail).

    `probe_sql` reads one row of a real table: Doris serves a constant from its
    frontend, so only a table read proves the backends are reachable."""
    if port(config) is None:
        return None
    if _fl is None:
        return NOT_INSTALLED, None
    key = _key(config)
    with _lock:
        hit = _checked.get(key)
    if hit and (hit[1] is None or time.monotonic() - hit[0] < _RECHECK_AFTER):
        return None if hit[1] is None else (hit[1], hit[2])
    found: tuple[str, str | None] | None = None
    if probe_sql:
        try:
            with contextlib.closing(_Session(config, password, _PROBE_TIMEOUT)) as session:
                session.read(probe_sql).read_all()
        except Exception as exc:  # any failure means: use the MySQL protocol
            found = (status_of(exc), str(exc).splitlines()[0][:300])
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
    session = None
    try:
        session = _Session(config, password)
        batches = session.read(sql)
    except Exception as exc:
        if session is not None:
            session.close()
        if isinstance(exc, Unreachable):
            raise
        if _is_transport_error(exc):
            raise Unreachable(str(exc).splitlines()[0], status_of(exc)) from exc
        raise
    try:
        yield batches, session.cancel
    finally:
        session.close()


def is_transport_error(exc: Exception) -> bool:
    return _fl is not None and _is_transport_error(exc)
