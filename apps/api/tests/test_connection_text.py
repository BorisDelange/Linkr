"""The driver's text on a failed connection names the hosts and ports that
answer: an instance admin reads it, anyone else a reference to the logs. The
caller's own SQL errors and Linkr's deliberate refusals stay readable."""

import duckdb
import pytest

from app.models.data_source import DataSource
from app.services import database_credential_service as creds
from app.services.data import db_connect
from tests.test_cohort_derive_routes import API, _admin, _managed
from tests.test_derive_workspace_bounds import _member

REFUSED = 'connection to server at "127.0.0.1", port 54321 failed: Connection refused'
PG = {"engine": "postgresql", "host": "127.0.0.1", "port": 54321, "database": "x", "sslmode": "disable"}


@pytest.fixture(autouse=True)
def _no_session_logins():
    yield
    with creds._session_lock:
        creds._session.clear()


class _Refusing:
    def execute(self, sql, *args, **kwargs):
        if sql.lstrip().upper().startswith("ATTACH"):
            raise duckdb.IOException(REFUSED)
        return self

    def close(self):
        pass


@pytest.fixture
def unreachable(monkeypatch):
    monkeypatch.setattr(db_connect, "_connect", lambda *a, **k: _Refusing())


async def _setup(client, db):
    admin = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "WS"}})).json()["id"]
    member = await _member(client, db, "member", {ws: "editor"})
    r = await client.post(f"{API}/data-sources", headers=admin, json={
        "workspaceId": ws, "alias": "pg", "name": {"en": "pg"}, "sourceType": "database", "connectionConfig": PG,
    })
    assert r.status_code == 201, r.text
    return admin, member, ws, r.json()["id"]


def _names_the_network(text: str) -> bool:
    return "127.0.0.1" in text or "54321" in text or "refused" in text.lower()


async def test_saving_a_login_tells_a_member_no_host_or_port(client, db, unreachable):
    admin, member, _, ds = await _setup(client, db)
    login = {"username": "u", "password": "dummy-p", "remember": False}

    r = await client.put(f"{API}/data-sources/{ds}/my-login", headers=member, json=login)
    assert r.status_code == 422 and not _names_the_network(r.text), r.text
    assert "ref." in r.text or "login" in r.text.lower()

    r = await client.put(f"{API}/data-sources/{ds}/my-login", headers=admin, json=login)
    assert r.status_code == 422 and "Connection refused" in r.text


async def test_a_query_tells_a_member_no_host_or_port(client, db, unreachable):
    admin, member, _, ds = await _setup(client, db)
    for user_id in (1, 2):
        await creds.save(db, await db.get(DataSource, ds), user_id, "u", "dummy-p", remember=True)

    r = await client.post(f"{API}/data-sources/{ds}/query", headers=member, json={"sql": "SELECT 1"})
    assert r.status_code == 422 and not _names_the_network(r.text), r.text

    r = await client.post(f"{API}/data-sources/{ds}/query", headers=admin, json={"sql": "SELECT 1"})
    assert r.status_code == 422 and "Connection refused" in r.text


async def test_the_connection_test_still_shows_an_admin_the_driver_text(client, db, unreachable):
    admin, member, ws, _ = await _setup(client, db)
    body = {"workspaceId": ws, "connectionConfig": {**PG, "username": "u", "password": "dummy-p"}}
    r = await client.post(f"{API}/data-sources/test-connection", headers=admin, json=body)
    assert r.json()["ok"] is False and "Connection refused" in r.json()["error"]
    r = await client.post(f"{API}/data-sources/test-connection", headers=member, json=body)
    assert r.json()["ok"] is False and not _names_the_network(r.json()["error"])


async def test_a_sql_error_still_reaches_its_author(client, db):
    admin = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "WS"}})).json()["id"]
    member = await _member(client, db, "member", {ws: "editor"})
    ds = await _managed(client, admin, ws, "file", seed=True)
    r = await client.post(f"{API}/data-sources/{ds}/query", headers=member, json={"sql": "SELECT no_such_column FROM person"})
    assert r.status_code == 422 and "no_such_column" in r.text


async def test_a_refused_host_is_still_named_to_a_member(client, db, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "db_allowed_hosts", "db.allowed.internal")
    _, member, _, ds = await _setup(client, db)
    r = await client.put(f"{API}/data-sources/{ds}/my-login", headers=member, json={"username": "u", "password": "dummy-p"})
    assert r.status_code == 422 and "not allowed" in r.text
