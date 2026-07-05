from app.core.security import hash_password
from app.models.user import User

API = "/api/v1"


async def _admin_headers(client) -> dict:
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw"}
    )
    r = await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "pw"}
    )
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _create_user(db, client, username: str) -> dict:
    db.add(User(username=username, password_hash=hash_password("pw"), role="user"))
    await db.commit()
    r = await client.post(
        f"{API}/auth/login", json={"username": username, "password": "pw"}
    )
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _make_workspace(client, headers) -> str:
    r = await client.post(
        f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}}
    )
    return r.json()["id"]


async def test_global_preset_upsert_and_list(client):
    headers = await _admin_headers(client)

    # Create (PUT = upsert), no workspace → global preset.
    r = await client.put(
        f"{API}/schema-presets/p1",
        headers=headers,
        json={"presetId": "p1", "mapping": {"tables": []}},
    )
    assert r.status_code == 200
    assert r.json()["presetId"] == "p1"
    assert "createdAt" in r.json()

    # Update the same preset via PUT.
    r = await client.put(
        f"{API}/schema-presets/p1",
        headers=headers,
        json={"presetId": "p1", "mapping": {"tables": ["person"]}},
    )
    assert r.status_code == 200 and r.json()["mapping"] == {"tables": ["person"]}

    r = await client.get(f"{API}/schema-presets", headers=headers)
    assert [p["presetId"] for p in r.json()] == ["p1"]

    r = await client.delete(f"{API}/schema-presets/p1", headers=headers)
    assert r.status_code == 204


async def test_body_url_mismatch_rejected(client):
    headers = await _admin_headers(client)
    r = await client.put(
        f"{API}/schema-presets/p1",
        headers=headers,
        json={"presetId": "other", "mapping": {}},
    )
    assert r.status_code == 400


async def test_workspace_preset_permission(client, db):
    admin = await _admin_headers(client)
    ws_id = await _make_workspace(client, admin)

    # Admin (owner) can save a workspace-scoped preset.
    r = await client.put(
        f"{API}/schema-presets/wp",
        headers=admin,
        json={"presetId": "wp", "workspaceId": ws_id, "mapping": {}},
    )
    assert r.status_code == 200

    # A non-member cannot save into that workspace, nor see the preset.
    other = await _create_user(db, client, "bob")
    r = await client.put(
        f"{API}/schema-presets/wp2",
        headers=other,
        json={"presetId": "wp2", "workspaceId": ws_id, "mapping": {}},
    )
    assert r.status_code == 403

    r = await client.get(f"{API}/schema-presets", headers=other)
    assert all(p["presetId"] != "wp" for p in r.json())
