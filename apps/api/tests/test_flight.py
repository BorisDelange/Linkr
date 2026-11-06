"""flight: when a large result may go over Arrow Flight, and what the database
page is told when it may not."""

import datetime
import os
import threading

import duckdb
import pyarrow as pa
import pyarrow.flight as fl
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from app.config import settings
from app.core.security import hash_password
from app.models.user import User
from app.models.workspace_member import WorkspaceMember
from app.services import database_credential_service as creds
from app.services.data import flight
from tests.test_ide_files import _admin_headers

API = "/api/v1"
DORIS = {"engine": "doris", "host": "doris.internal", "username": "reader"}


@pytest.fixture(autouse=True)
def _clean():
    flight._checked.clear()
    yield
    flight._checked.clear()


def test_only_doris_has_a_flight_port():
    assert flight.port(DORIS) == 8070
    assert flight.port({**DORIS, "flightPort": 18070}) == 18070
    assert flight.port({**DORIS, "engine": "postgresql"}) is None
    assert flight.problem({**DORIS, "engine": "mysql"}, None, "SELECT 1") is None


def test_without_the_flight_client_flight_is_not_installed(monkeypatch):
    monkeypatch.setattr(flight, "_fl", None)
    assert flight.problem(DORIS, None, "SELECT 1") == (flight.NOT_INSTALLED, None)


def test_a_failed_probe_is_remembered_then_retried(monkeypatch):
    calls: list[str] = []

    def client(location, options):
        calls.append(location)
        raise OSError("connection error: dial tcp 10.0.0.3:8050: i/o timeout")

    monkeypatch.setattr(flight, "_client", client)
    first = flight.problem(DORIS, "pw", "SELECT 1 AS one FROM t LIMIT 1")
    assert first[0] == flight.UNREACHABLE and "i/o timeout" in first[1]
    assert flight.problem(DORIS, "pw", "SELECT 1 AS one FROM t LIMIT 1") == first
    assert calls == ["grpc://doris.internal:8070"]

    monkeypatch.setattr(flight, "_RECHECK_AFTER", -1.0)
    flight.problem(DORIS, "pw", "SELECT 1 AS one FROM t LIMIT 1")
    assert len(calls) == 2


def test_tls_follows_the_sources_sslmode(monkeypatch, tmp_path):
    """libpq's words: `require` encrypts without checking the server's
    certificate, `verify-*` check it, against `sslrootcert` when given."""
    assert flight.uri(DORIS) == "grpc://doris.internal:8070"
    assert flight.uri({**DORIS, "sslmode": "disable"}) == "grpc://doris.internal:8070"
    assert flight.uri({**DORIS, "sslmode": "require"}) == "grpc+tls://doris.internal:8070"
    assert flight.uri({**DORIS, "sslmode": "verify-full"}) == "grpc+tls://doris.internal:8070"

    seen: list[tuple[str, dict]] = []

    def client(location, options):
        seen.append((location, options))
        raise OSError("Unavailable")

    monkeypatch.setattr(flight, "_client", client)
    ca = tmp_path / "ca.pem"
    ca.write_text("-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n")
    for config in ({**DORIS, "sslmode": "require"}, {**DORIS, "sslmode": "verify-ca", "sslrootcert": str(ca)}, DORIS):
        flight._checked.clear()
        flight.problem(config, "pw", "SELECT 1 AS one FROM t LIMIT 1")
    assert [u for u, _ in seen] == ["grpc+tls://doris.internal:8070"] * 2 + ["grpc://doris.internal:8070"]
    require, verify, plain = (kw for _, kw in seen)
    assert require == {"disable_server_verification": True}
    assert verify == {"tls_root_certs": ca.read_bytes()}
    assert plain == {}


def test_a_refused_login_is_not_an_unreachable_port(monkeypatch):
    def client(location, options):
        raise OSError("rpc error: code = Unauthenticated desc = invalid user or password")

    monkeypatch.setattr(flight, "_client", client)
    found = flight.problem(DORIS, "pw", "SELECT 1 AS one FROM t LIMIT 1")
    assert found[0] == flight.UNAUTHENTICATED and "invalid user" in found[1]
    assert flight.status_of(OSError("dial tcp: i/o timeout")) == flight.UNREACHABLE


def test_a_transport_failure_is_told_from_a_query_error():
    assert flight.is_transport_error(OSError("rpc error: code = Unavailable desc = connection error"))
    assert not flight.is_transport_error(OSError("MEM_LIMIT_EXCEEDED"))


def test_a_new_flight_port_forgets_the_logins_without_resealing_them():
    """The password goes to the Flight port too, so moving it is a retarget; but
    it must not enter the seal of the passwords already stored."""
    before = {"engine": "doris", "host": "h", "port": 9030, "database": "omop"}
    assert creds.target_changed(before, {**before, "flightPort": 9999})
    assert not creds.target_changed(before, dict(before))
    assert creds.target_of(before) == creds.target_of({**before, "flightPort": 9999})
    assert creds.target_changed(before, {**before, "sslrootcert": "/ca.pem"})
    assert creds.target_of(before) == creds.target_of({**before, "sslrootcert": "/ca.pem"})


# --- Against real Flight endpoints, on loopback ---------------------------------


class _Token(fl.ServerMiddleware):
    def sending_headers(self):
        return {"authorization": "Bearer dummy-token"}


class _Seen(fl.ServerMiddlewareFactory):
    """Who called what, and with which credential."""

    def __init__(self, calls: list):
        self.calls = calls

    def start_call(self, info, headers):
        self.calls.append((info.method.name, (headers.get("authorization") or [""])[0]))
        return _Token()


class _NoAuth(fl.ServerAuthHandler):
    def authenticate(self, outgoing, incoming):
        pass

    def is_valid(self, token):
        return ""


class _Backend(fl.FlightServerBase):
    def __init__(self, location="grpc://127.0.0.1:0", **kwargs):
        self.calls: list = []
        super().__init__(location, auth_handler=_NoAuth(), middleware={"seen": _Seen(self.calls)}, **kwargs)
        threading.Thread(target=self.serve, daemon=True).start()

    def do_get(self, context, ticket):
        return fl.RecordBatchStream(pa.table({"one": [int(ticket.ticket)]}))


class _Frontend(_Backend):
    """Announces `locations` for each query, one endpoint per list."""

    def __init__(self, endpoints: list[list[str]], **kwargs):
        self.endpoints = endpoints
        self.commands: list[bytes] = []
        super().__init__(**kwargs)

    def get_flight_info(self, context, descriptor):
        self.commands.append(descriptor.command)
        schema = pa.schema([("one", pa.int64())])
        points = [fl.FlightEndpoint(str(i + 1).encode(), [fl.Location(u) for u in urls]) for i, urls in enumerate(self.endpoints)]
        return fl.FlightInfo(schema, descriptor, points, -1, -1)


def _config(frontend: _Frontend, host: str = "127.0.0.1", **extra) -> dict:
    return {"engine": "doris", "host": host, "flightPort": frontend.port, "username": "dummy_user", **extra}


def _rows(config: dict) -> list:
    with flight.reader(config, "dummy_password", "SELECT 1") as (batches, _cancel):
        return batches.read_all().to_pylist()


@pytest.fixture
def servers():
    started: list[_Backend] = []

    def start(cls, *args, **kwargs):
        server = cls(*args, **kwargs)
        started.append(server)
        return server

    yield start
    for server in started:
        server.shutdown()


def test_a_result_is_read_from_the_frontend_when_it_announces_no_location(servers):
    frontend = servers(_Frontend, [[]])
    assert _rows(_config(frontend)) == [{"one": 1}]
    assert ("DO_GET", "Bearer dummy-token") in frontend.calls


def test_a_result_is_read_from_every_endpoint_on_an_allowed_backend(servers, monkeypatch):
    backend = servers(_Backend)
    frontend = servers(_Frontend, [[f"grpc://127.0.0.1:{backend.port}"], [f"grpc://127.0.0.1:{backend.port}"]])
    monkeypatch.setattr(settings, "db_allowed_hosts", "127.0.0.1/32")
    assert _rows(_config(frontend)) == [{"one": 1}, {"one": 2}]
    assert ("DO_GET", "Bearer dummy-token") in backend.calls


def test_a_backend_outside_the_host_allowlist_is_never_contacted(servers, monkeypatch):
    backend = servers(_Backend)
    frontend = servers(_Frontend, [[f"grpc://127.0.0.1:{backend.port}"]])
    monkeypatch.setattr(settings, "db_allowed_hosts", "localhost")

    with pytest.raises(flight.Unreachable, match="not allowed"):
        _rows(_config(frontend, host="localhost"))
    assert backend.calls == []

    flight._checked.clear()
    found = flight.problem(_config(frontend, host="localhost"), "dummy_password", "SELECT 1")
    assert found[0] == flight.UNREACHABLE and "not allowed" in found[1]
    assert backend.calls == []


def test_one_refused_endpoint_stops_the_query_before_any_row_is_asked_for(servers, monkeypatch):
    allowed = servers(_Backend)
    other = servers(_Backend)
    frontend = servers(_Frontend, [[f"grpc://localhost:{allowed.port}"], [f"grpc://127.0.0.1:{other.port}"]])
    monkeypatch.setattr(settings, "db_allowed_hosts", "localhost")

    with pytest.raises(flight.Unreachable):
        _rows(_config(frontend, host="localhost"))
    assert allowed.calls == [] and other.calls == []


@pytest.mark.parametrize("uri", ["grpc+unix:///tmp/x", "http://127.0.0.1:1", "grpc://", "grpc+tcp://"])
def test_only_a_network_flight_location_is_followed(uri):
    with pytest.raises(flight.Unreachable):
        flight._checked_location(DORIS, uri)


def test_a_location_is_kept_on_the_tls_a_source_requires():
    secure = {**DORIS, "sslmode": "verify-full"}
    assert flight._checked_location(DORIS, "grpc://be:8050") == "grpc://be:8050"
    assert flight._checked_location(DORIS, "grpc+tcp://be:8050") == "grpc+tcp://be:8050"
    assert flight._checked_location(secure, "grpc+tls://be:8050") == "grpc+tls://be:8050"
    assert flight._checked_location(secure, b"arrow-flight-reuse-connection://?") is None
    for plain in ("grpc://be:8050", "grpc+tcp://be:8050"):
        with pytest.raises(flight.Unreachable):
            flight._checked_location(secure, plain)


def _self_signed(tmp_path) -> tuple[bytes, bytes, str]:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    pem = cert.public_bytes(serialization.Encoding.PEM)
    ca = tmp_path / "ca.pem"
    ca.write_bytes(pem)
    return pem, key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption(),
    ), str(ca)


def test_a_tls_source_sends_nothing_to_a_cleartext_backend(servers, tmp_path):
    pem, key, ca = _self_signed(tmp_path)
    backend = servers(_Backend)
    frontend = servers(
        _Frontend, [[f"grpc://127.0.0.1:{backend.port}"]], location="grpc+tls://localhost:0", tls_certificates=[(pem, key)],
    )
    with pytest.raises(flight.Unreachable):
        _rows(_config(frontend, host="localhost", sslmode="verify-full", sslrootcert=ca))
    assert frontend.commands and backend.calls == []


def test_a_verified_source_reads_over_tls_and_refuses_another_certificate(servers, tmp_path):
    pem, key, ca = _self_signed(tmp_path)
    frontend = servers(_Frontend, [[]], location="grpc+tls://localhost:0", tls_certificates=[(pem, key)])
    assert _rows(_config(frontend, host="localhost", sslmode="verify-full", sslrootcert=ca)) == [{"one": 1}]
    assert _rows(_config(frontend, host="localhost", sslmode="require")) == [{"one": 1}]

    (tmp_path / "other").mkdir()
    _other_pem, _other_key, other_ca = _self_signed(tmp_path / "other")
    flight._checked.clear()
    before = len(frontend.calls)
    found = flight.problem(_config(frontend, host="localhost", sslmode="verify-full", sslrootcert=other_ca), "pw", "SELECT 1")
    assert found[0] == flight.UNREACHABLE
    assert len(frontend.calls) == before


def test_a_result_scans_as_a_duckdb_view_and_a_query_is_sent_as_flight_sql(servers):
    frontend = servers(_Frontend, [[], []])
    con = duckdb.connect()
    with flight.reader(_config(frontend), "dummy_password", "SELECT 'é'") as (batches, _cancel):
        con.register("result", batches)
        assert con.execute("SELECT sum(one) FROM result").fetchone() == (3,)
    query = "SELECT 'é'".encode()
    assert frontend.commands == [
        b"\x0a" + bytes([67]) + b"type.googleapis.com/arrow.flight.protocol.sql.CommandStatementQuery"
        + b"\x12" + bytes([len(query) + 2]) + b"\x0a" + bytes([len(query)]) + query
    ]


def test_a_long_statement_keeps_a_valid_length_prefix():
    long = "x" * 300
    command = flight._statement_command(long)
    assert command.endswith(b"\x0a\xac\x02" + long.encode())


def test_a_refused_login_reads_as_unauthenticated():
    assert flight.status_of(fl.FlightUnauthenticatedError("invalid")) == flight.UNAUTHENTICATED
    assert flight.is_transport_error(fl.FlightUnavailableError("failed to connect"))
    assert flight.is_transport_error(fl.FlightTimedOutError("Deadline Exceeded"))
    assert not flight.is_transport_error(fl.FlightInternalError("MEM_LIMIT_EXCEEDED"))


# --- The CA file a source names ---------------------------------------------------

SECURE = {**DORIS, "sslmode": "verify-ca"}


@pytest.mark.parametrize("make", ["missing", "directory", "binary", "text", "oversized", "fifo", "device"])
def test_a_root_cert_is_a_bounded_regular_pem_file_and_says_nothing_about_others(make, tmp_path):
    path = tmp_path / "ca.pem"
    if make == "directory":
        path.mkdir()
    elif make == "binary":
        path.write_bytes(b"\xff\xfe\x00")
    elif make == "text":
        path.write_text("not a certificate")
    elif make == "oversized":
        path.write_bytes(b"-----BEGIN CERTIFICATE-----\n" + b"x" * (flight._ROOT_CERT_MAX + 1))
    elif make == "fifo":
        os.mkfifo(path)
    elif make == "device":
        path = "/dev/zero"

    with pytest.raises(flight.Unreachable) as refused:
        flight._read_root_cert(str(path))
    assert str(refused.value) == flight._BAD_ROOT_CERT


def test_a_root_cert_that_cannot_be_used_only_sends_results_over_mysql(tmp_path):
    found = flight.problem({**SECURE, "sslrootcert": "/dev/zero"}, "pw", "SELECT 1 AS one FROM t LIMIT 1")
    assert found == (flight.UNREACHABLE, flight._BAD_ROOT_CERT)
    flight._checked.clear()
    with pytest.raises(flight.Unreachable):
        with flight.reader({**SECURE, "sslrootcert": str(tmp_path / "none.pem")}, "pw", "SELECT 1"):
            pass


async def _doris_source(client, headers, ws: str, source_id: str = "dor", **extra):
    return await client.post(f"{API}/data-sources", headers=headers, json={
        "id": source_id, "workspaceId": ws, "alias": source_id, "name": {"en": "d"}, "sourceType": "database",
        "connectionConfig": {"engine": "doris", "host": "doris.internal", "port": 9030, "database": "omop", **extra},
    })


async def _editor(client, db, admin) -> tuple[str, dict]:
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "W"}})).json()["id"]
    user = User(username="carol", password_hash=hash_password("pw-for-tests-only"), role="user")
    db.add(user)
    await db.flush()
    db.add(WorkspaceMember(workspace_id=ws, user_id=user.id, role="editor"))
    await db.commit()
    r = await client.post(f"{API}/auth/login", json={"username": "carol", "password": "pw-for-tests-only"})
    return ws, {"Authorization": f"Bearer {r.json()['access_token']}"}


async def test_a_member_names_a_root_cert_only_where_they_may_read(client, db, seed_roles, monkeypatch, tmp_path_factory):
    admin = await _admin_headers(client)
    ws, carol = await _editor(client, db, admin)
    root = tmp_path_factory.mktemp("browse")
    ca = root / "ca.pem"
    ca.write_text("-----BEGIN CERTIFICATE-----\n")
    monkeypatch.setattr(settings, "fs_browse_roots", str(root))
    outside = tmp_path_factory.mktemp("outside") / "ca.pem"
    outside.write_text("-----BEGIN CERTIFICATE-----\n")

    for refused in (str(outside), "/dev/zero", str(root)):
        assert (await _doris_source(client, carol, ws, sslrootcert=refused)).status_code >= 400, refused
    created = await _doris_source(client, carol, ws, sslrootcert=str(ca))
    assert created.status_code == 201, created.text

    moved = await client.patch(f"{API}/data-sources/dor", headers=carol, json={
        "connectionConfig": {**created.json()["connectionConfig"], "sslrootcert": str(outside)},
    })
    assert moved.status_code >= 400


async def test_an_administrator_names_a_root_cert_outside_the_browse_roots_but_only_a_file(client, db, seed_roles, tmp_path_factory):
    admin = await _admin_headers(client)
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "W"}})).json()["id"]
    ca = tmp_path_factory.mktemp("system") / "ca.pem"
    ca.write_text("-----BEGIN CERTIFICATE-----\n")

    assert (await _doris_source(client, admin, ws, sslrootcert="/dev/zero")).status_code >= 400
    created = await _doris_source(client, admin, ws, sslrootcert=str(ca))
    assert created.status_code == 201, created.text


async def test_a_flight_failure_is_detailed_only_to_an_administrator(client, db, seed_roles, monkeypatch):
    from app.services import data_source_service

    admin = await _admin_headers(client)
    ws, carol = await _editor(client, db, admin)
    assert (await _doris_source(client, admin, ws)).status_code == 201

    async def status(source, login):
        return {"status": flight.UNREACHABLE, "detail": "dial tcp 10.0.0.3:8050: refused", "port": 8070, "tls": False}

    async def login(db, source, user):
        return None

    monkeypatch.setattr(data_source_service, "flight_status", status)
    monkeypatch.setattr("app.api.v1.routes.data_sources._login", login)

    told = (await client.get(f"{API}/data-sources/dor/flight", headers=admin)).json()
    assert "10.0.0.3" in told["detail"]
    told = (await client.get(f"{API}/data-sources/dor/flight", headers=carol)).json()
    assert told["status"] == flight.UNREACHABLE and "10.0.0.3" not in told["detail"]
