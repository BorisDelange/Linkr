from app.core import crypto
from app.core.security import hash_password
from app.models.ide_connection import IdeConnection
from app.models.user import User

API = "/api/v1"


async def _admin_headers(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _create_user(db, client, username: str) -> dict:
    db.add(User(username=username, password_hash=hash_password("pw"), role="user"))
    await db.commit()
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _project(client, headers) -> str:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    return (await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]


async def test_connection_secret_stripped_and_encrypted(client, db):
    headers = await _admin_headers(client)
    proj = await _project(client, headers)

    created = (await client.post(f"{API}/ide-connections", headers=headers, json={
        "id": "c1", "projectUid": proj, "name": "PG", "source": "external",
        "connectionConfig": {
            "engine": "postgresql", "host": "db", "port": 5432,
            "database": "omop", "username": "u", "password": "s3cret",
        },
    })).json()
    # Password never comes back in the config.
    assert "password" not in created["connectionConfig"]
    assert created["connectionConfig"]["host"] == "db"

    # Stored encrypted (not plaintext) and decryptable server-side.
    row = await db.get(IdeConnection, "c1")
    assert row.connection_secret and row.connection_secret != "s3cret"
    assert crypto.decrypt(row.connection_secret) == "s3cret"
    assert "password" not in row.connection_config

    # GET never leaks the password either.
    got = (await client.get(f"{API}/ide-connections/c1", headers=headers)).json()
    assert "password" not in got["connectionConfig"]


async def test_update_without_password_keeps_secret(client, db):
    headers = await _admin_headers(client)
    proj = await _project(client, headers)
    await client.post(f"{API}/ide-connections", headers=headers, json={
        "id": "c1", "projectUid": proj, "name": "PG", "source": "external",
        "connectionConfig": {"engine": "postgresql", "host": "db", "password": "s3cret"},
    })
    # Update other config fields WITHOUT a password — the stored secret must survive.
    await client.patch(f"{API}/ide-connections/c1", headers=headers, json={
        "connectionConfig": {"engine": "postgresql", "host": "newhost"},
    })
    row = await db.get(IdeConnection, "c1")
    assert crypto.decrypt(row.connection_secret) == "s3cret"
    assert row.connection_config["host"] == "newhost"


async def test_list_and_delete(client):
    headers = await _admin_headers(client)
    proj = await _project(client, headers)
    await client.post(f"{API}/ide-connections", headers=headers, json={
        "id": "c1", "projectUid": proj, "name": "L", "source": "warehouse", "connectionConfig": {},
    })
    listed = (await client.get(f"{API}/ide-connections?projectUid={proj}", headers=headers)).json()
    assert [c["id"] for c in listed] == ["c1"]
    assert (await client.delete(f"{API}/ide-connections/c1", headers=headers)).status_code == 204


async def test_non_member_cannot_access(client, db):
    admin = await _admin_headers(client)
    proj = await _project(client, admin)
    await client.post(f"{API}/ide-connections", headers=admin, json={
        "id": "c1", "projectUid": proj, "name": "X", "source": "warehouse", "connectionConfig": {},
    })
    other = await _create_user(db, client, "bob")
    assert (await client.get(f"{API}/ide-connections?projectUid={proj}", headers=other)).status_code == 403
