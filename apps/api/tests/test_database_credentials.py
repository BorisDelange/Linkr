"""Per-user database logins: an external database opens only with the acting
user's own login, never another user's, never after it was pointed elsewhere."""

import pytest
from sqlalchemy import select

from app.core.security import hash_password
from app.models.data_source import DataSource
from app.models.database_credential import DatabaseCredential
from app.models.user import User
from app.services import data_source_service, database_credential_service as creds
from app.services.database_credential_service import CredentialRequired

API = "/api/v1"


@pytest.fixture(autouse=True)
def _no_session_logins():
    yield
    with creds._session_lock:
        creds._session.clear()


async def _user(db, username: str) -> User:
    user = User(username=username, password_hash=hash_password("pw"), role="user")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def _pg(db, **extra) -> DataSource:
    source = DataSource(
        alias="pg", name={"en": "PG"}, source_type="database",
        connection_config={"engine": "postgresql", "host": "h", "port": 5432, "database": "omop"},
        **extra,
    )
    db.add(source)
    await db.commit()
    await db.refresh(source)
    return source


async def test_file_database_needs_no_login(db):
    source = DataSource(alias="f", name={"en": "F"}, source_type="database", connection_config={"engine": "duckdb"})
    db.add(source)
    await db.commit()
    assert await creds.resolve_login(db, source, 1) is None
    assert creds.principal_for(source, 1) == ""


async def test_no_login_is_428(db):
    source = await _pg(db)
    alice = await _user(db, "alice")
    with pytest.raises(CredentialRequired) as exc:
        await creds.resolve_login(db, source, alice.id)
    assert exc.value.status_code == 428
    assert exc.value.detail["dataSourceId"] == source.id


async def test_login_is_the_users_own(db):
    source = await _pg(db)
    alice, bob = await _user(db, "alice"), await _user(db, "bob")
    await creds.save(db, source, alice.id, "alice_db", "pw-a", remember=True)

    login = await creds.resolve_login(db, source, alice.id)
    assert (login.username, login.password, login.principal) == ("alice_db", "pw-a", f"user:{alice.id}")
    with pytest.raises(CredentialRequired):
        await creds.resolve_login(db, source, bob.id)


async def test_ciphertext_copied_to_another_user_does_not_open(db):
    """Write access to the Linkr database is not enough to borrow a login."""
    source = await _pg(db)
    alice, bob = await _user(db, "alice"), await _user(db, "bob")
    await creds.save(db, source, alice.id, "alice_db", "pw-a", remember=True)
    stolen = (await db.execute(select(DatabaseCredential))).scalar_one()
    db.add(DatabaseCredential(user_id=bob.id, data_source_id=source.id, username=stolen.username, secret=stolen.secret))
    await db.commit()

    with pytest.raises(CredentialRequired):
        await creds.resolve_login(db, source, bob.id)
    # The useless row is dropped, so the UI simply asks bob for his own.
    rows = (await db.execute(select(DatabaseCredential.user_id))).scalars().all()
    assert rows == [alice.id]


async def test_session_only_login_is_never_stored(db):
    source = await _pg(db)
    alice = await _user(db, "alice")
    await creds.save(db, source, alice.id, "alice_db", "pw-a", remember=False)
    assert (await db.execute(select(DatabaseCredential))).first() is None
    assert (await creds.resolve_login(db, source, alice.id)).password == "pw-a"

    creds.forget_session_logins(alice.id)
    with pytest.raises(CredentialRequired):
        await creds.resolve_login(db, source, alice.id)


async def test_database_requiring_session_only_ignores_remember(db):
    source = await _pg(db, require_session_only=True)
    alice = await _user(db, "alice")
    await creds.save(db, source, alice.id, "alice_db", "pw-a", remember=True)
    assert (await db.execute(select(DatabaseCredential))).first() is None
    assert (await creds.resolve_login(db, source, alice.id)).password == "pw-a"


async def test_session_login_does_not_follow_a_retarget(db):
    source = await _pg(db)
    alice = await _user(db, "alice")
    await creds.save(db, source, alice.id, "alice_db", "pw-a", remember=False)
    source.connection_config = {**source.connection_config, "host": "elsewhere"}
    await db.commit()
    with pytest.raises(CredentialRequired):
        await creds.resolve_login(db, source, alice.id)


async def test_login_does_not_follow_a_retarget_even_if_left_in_place(db):
    """Belt and braces: `update` deletes the rows, but a row that survived
    (a direct edit of the Linkr database) is sealed to the old target."""
    source = await _pg(db)
    alice = await _user(db, "alice")
    await creds.save(db, source, alice.id, "alice_db", "pw-a", remember=True)
    source.connection_config = {**source.connection_config, "host": "evil"}
    await db.commit()
    with pytest.raises(CredentialRequired):
        await creds.resolve_login(db, source, alice.id)


def test_with_login_names_linkr_to_postgres():
    login = creds.Login("me", "pw", "user:1")
    config = creds.with_login({"engine": "postgresql", "host": "h"}, login)
    assert config["username"] == "me" and config["application_name"] == "linkr"
    assert "application_name" not in creds.with_login({"engine": "mysql"}, login)


def test_pool_key_is_per_user():
    source = DataSource(id="s1", connection_config={"engine": "postgresql"})
    a, b = creds.Login("a", "x", "user:1"), creds.Login("b", "y", "user:2")
    assert creds.pool_key(source, a) != creds.pool_key(source, b)
    assert creds.pool_key(source, None) == "s1"


# --- Routes ---------------------------------------------------------------------

async def _login_headers(client, username: str) -> dict:
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _setup(client, db):
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    admin = await _login_headers(client, "admin")
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "WS"}})).json()["id"]
    ds = (await client.post(f"{API}/data-sources", headers=admin, json={
        "workspaceId": ws, "alias": "pg", "name": "PG", "sourceType": "database",
        "connectionConfig": {"engine": "postgresql", "host": "h", "database": "omop"},
    })).json()
    return admin, ds["id"]


async def test_my_login_is_tested_before_it_is_kept(client, db, monkeypatch):
    admin, source_id = await _setup(client, db)

    async def refuse(config):
        assert config["username"] == "me" and config["password"] == "bad"
        return False, "password authentication failed", []

    monkeypatch.setattr(data_source_service, "test_connection", refuse)
    r = await client.put(f"{API}/data-sources/{source_id}/my-login", headers=admin,
                         json={"username": "me", "password": "bad"})
    assert r.status_code == 422
    assert (await db.execute(select(DatabaseCredential))).first() is None


async def test_my_login_roundtrip(client, db, monkeypatch):
    admin, source_id = await _setup(client, db)

    async def accept(config):
        return True, None, []

    monkeypatch.setattr(data_source_service, "test_connection", accept)
    assert (await client.get(f"{API}/data-sources/{source_id}/my-login", headers=admin)).json()["hasLogin"] is False

    r = await client.put(f"{API}/data-sources/{source_id}/my-login", headers=admin,
                         json={"username": "me", "password": "good"})
    assert r.status_code == 200
    body = r.json()
    assert body["hasLogin"] and body["username"] == "me" and body["remembered"]
    assert "good" not in r.text

    listed = (await client.get(f"{API}/auth/database-logins", headers=admin)).json()
    assert [(e["dataSourceId"], e["username"]) for e in listed] == [(source_id, "me")]
    assert (await client.get(f"{API}/data-sources/{source_id}/login-count", headers=admin)).json() == {"count": 1}

    assert (await client.delete(f"{API}/data-sources/{source_id}/my-login", headers=admin)).status_code == 204
    assert (await client.get(f"{API}/data-sources/{source_id}/my-login", headers=admin)).json()["hasLogin"] is False


async def test_an_api_key_cannot_set_a_password(client, db):
    admin, source_id = await _setup(client, db)
    token = (await client.post(f"{API}/auth/api-tokens", headers=admin, json={"name": "mcp"})).json()["token"]
    r = await client.put(f"{API}/data-sources/{source_id}/my-login",
                         headers={"Authorization": f"Bearer {token}"}, json={"username": "x", "password": "y"})
    assert r.status_code == 401


async def test_stats_cache_is_per_user_on_an_external_database(client, db):
    """A count computed through one user's grants is never served to another."""
    admin, source_id = await _setup(client, db)
    bob_id = (await _user(db, "bob")).id
    bob = await _login_headers(client, "bob")
    ws = (await db.get(DataSource, source_id)).workspace_id
    r = await client.put(f"{API}/workspaces/{ws}/members", headers=admin, json={"userId": bob_id, "role": "viewer"})
    assert r.status_code < 400

    payload = {"computedAt": "2026-09-25T00:00:00Z", "payload": {"patients": 42}}
    assert (await client.put(f"{API}/data-sources/{source_id}/stats-cache", headers=admin, json=payload)).status_code == 200
    assert (await client.get(f"{API}/data-sources/{source_id}/stats-cache", headers=bob)).json() is None
    # A reader may cache their own view of an external database.
    assert (await client.put(f"{API}/data-sources/{source_id}/stats-cache", headers=bob, json=payload)).status_code == 200


async def test_logout_forgets_session_only_logins(client, db, monkeypatch):
    admin, source_id = await _setup(client, db)

    async def accept(config):
        return True, None, []

    monkeypatch.setattr(data_source_service, "test_connection", accept)
    await client.put(f"{API}/data-sources/{source_id}/my-login", headers=admin,
                     json={"username": "me", "password": "pw", "remember": False})
    assert (await client.get(f"{API}/data-sources/{source_id}/my-login", headers=admin)).json()["hasLogin"]
    await client.post(f"{API}/auth/logout", headers=admin)
    assert (await client.get(f"{API}/data-sources/{source_id}/my-login", headers=admin)).json()["hasLogin"] is False
