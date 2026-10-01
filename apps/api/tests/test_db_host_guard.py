"""LINKR_DB_ALLOWED_HOSTS bounds where the server opens database connections
(docs/design/spe-security.md §2). Private addresses must stay reachable when listed:
that is where an SPE's datamart lives."""

import socket

import pytest

from app.config import settings
from app.services.data import db_connect
from app.services.data.db_host_guard import DbHostNotAllowed, check_db_host


@pytest.fixture
def allow(monkeypatch):
    def _set(value: str):
        monkeypatch.setattr(settings, "db_allowed_hosts", value)
    return _set


@pytest.fixture
def dns(monkeypatch):
    table = {"datamart.chu.local": "10.20.1.4", "evil.example": "169.254.169.254", "wiki.chu.local": "10.30.0.2"}

    def fake(host, *_a, **_k):
        if host not in table:
            raise socket.gaierror(host)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (table[host], 0))]

    monkeypatch.setattr(socket, "getaddrinfo", fake)


def test_empty_allowlist_restricts_nothing(allow):
    allow("")
    check_db_host("169.254.169.254")
    check_db_host(None)


def test_listed_names_and_networks_pass(allow, dns):
    allow("pg.chu.local, 10.20.0.0/16")
    check_db_host("PG.chu.local")
    check_db_host("10.20.3.3")
    check_db_host("datamart.chu.local")  # resolves inside 10.20.0.0/16


@pytest.mark.parametrize("host", [
    "10.30.0.2",               # private, but not listed
    "wiki.chu.local",          # resolves outside the listed network
    "evil.example",            # resolves to the metadata endpoint
    "unresolvable.invalid",
    "10.20.1.1,10.30.0.2",     # libpq host list: every entry must pass
    "/var/run/postgresql",     # a socket directory
    None,                      # no host = the local socket
])
def test_everything_else_is_refused(allow, dns, host):
    allow("10.20.0.0/16")
    with pytest.raises(DbHostNotAllowed):
        check_db_host(host)


def test_every_external_connection_goes_through_the_guard(allow):
    allow("10.20.0.0/16")
    config = {"engine": "postgresql", "host": "127.0.0.1", "port": 5432}
    with pytest.raises(DbHostNotAllowed):
        db_connect.attach_recipe(config, "pw-for-tests-only")
    with pytest.raises(DbHostNotAllowed):
        db_connect.introspect_external(config, "pw-for-tests-only")
