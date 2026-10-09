"""flight: when a large result may go over Arrow Flight, and what the database
page is told when it may not."""

import pytest

from app.services import database_credential_service as creds
from app.services.data import flight

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


def test_without_the_extra_flight_is_not_installed(monkeypatch):
    monkeypatch.setattr(flight, "_flightsql", None)
    assert flight.problem(DORIS, None, "SELECT 1") == (flight.NOT_INSTALLED, None)


def test_a_failed_probe_is_remembered_then_retried(monkeypatch):
    calls: list[str] = []

    class Driver:
        @staticmethod
        def connect(uri, db_kwargs):
            calls.append(uri)
            raise OSError('connection error: dial tcp 10.0.0.3:8050: i/o timeout')

    monkeypatch.setattr(flight, "_flightsql", Driver)
    first = flight.problem(DORIS, "pw", "SELECT 1 AS one FROM t LIMIT 1")
    assert first[0] == flight.UNREACHABLE and "i/o timeout" in first[1]
    assert flight.problem(DORIS, "pw", "SELECT 1 AS one FROM t LIMIT 1") == first
    assert calls == ["grpc://doris.internal:8070"]

    monkeypatch.setattr(flight, "_RECHECK_AFTER", -1.0)
    flight.problem(DORIS, "pw", "SELECT 1 AS one FROM t LIMIT 1")
    assert len(calls) == 2


def test_a_transport_failure_is_told_from_a_query_error(monkeypatch):
    monkeypatch.setattr(flight, "_flightsql", object())
    assert flight.is_transport_error(OSError("rpc error: code = Unavailable desc = connection error"))
    assert not flight.is_transport_error(OSError("MEM_LIMIT_EXCEEDED"))


def test_a_new_flight_port_forgets_the_logins_without_resealing_them():
    """The password goes to the Flight port too, so moving it is a retarget; but
    it must not enter the seal of the passwords already stored."""
    before = {"engine": "doris", "host": "h", "port": 9030, "database": "omop"}
    assert creds.target_changed(before, {**before, "flightPort": 9999})
    assert not creds.target_changed(before, dict(before))
    assert creds.target_of(before) == creds.target_of({**before, "flightPort": 9999})
