from app.core.security import hash_password
from app.models.user import User

API = "/api/v1"


async def _bootstrap_admin(client) -> dict:
    """Create the first admin and return auth headers."""
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw"}
    )
    r = await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "pw"}
    )
    token = r.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


async def _create_user(db, client, username: str) -> dict:
    """Create a regular (non-admin) user and return auth headers."""
    db.add(
        User(username=username, password_hash=hash_password("pw"), role="user")
    )
    await db.commit()
    r = await client.post(
        f"{API}/auth/login", json={"username": username, "password": "pw"}
    )
    token = r.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


async def test_workspace_crud_flow(client):
    headers = await _bootstrap_admin(client)

    # Create — camelCase in and out, owner becomes a member.
    r = await client.post(
        f"{API}/workspaces",
        headers=headers,
        json={"name": {"en": "Demo"}, "gitRemoteConfig": {"url": "x"}},
    )
    assert r.status_code == 201
    ws = r.json()
    assert ws["name"] == {"en": "Demo"}
    assert "createdAt" in ws and "gitRemoteConfig" in ws  # camelCase emitted
    ws_id = ws["id"]

    # List contains it.
    r = await client.get(f"{API}/workspaces", headers=headers)
    assert r.status_code == 200
    assert any(w["id"] == ws_id for w in r.json())

    # Get by id.
    r = await client.get(f"{API}/workspaces/{ws_id}", headers=headers)
    assert r.status_code == 200

    # Patch.
    r = await client.patch(
        f"{API}/workspaces/{ws_id}",
        headers=headers,
        json={"name": {"en": "Renamed"}},
    )
    assert r.status_code == 200
    assert r.json()["name"] == {"en": "Renamed"}

    # Delete.
    r = await client.delete(f"{API}/workspaces/{ws_id}", headers=headers)
    assert r.status_code == 204
    r = await client.get(f"{API}/workspaces/{ws_id}", headers=headers)
    assert r.status_code in (403, 404)


async def test_client_supplied_id_is_kept(client):
    headers = await _bootstrap_admin(client)
    r = await client.post(
        f"{API}/workspaces",
        headers=headers,
        json={"id": "ws-fixed-123", "name": {"en": "X"}},
    )
    assert r.status_code == 201
    assert r.json()["id"] == "ws-fixed-123"


async def test_non_member_cannot_see_or_access(client, db):
    admin_headers = await _bootstrap_admin(client)
    r = await client.post(
        f"{API}/workspaces", headers=admin_headers, json={"name": {"en": "Secret"}}
    )
    ws_id = r.json()["id"]

    # A different regular user is not a member.
    other_headers = await _create_user(db, client, "bob")

    r = await client.get(f"{API}/workspaces", headers=other_headers)
    assert r.status_code == 200
    assert all(w["id"] != ws_id for w in r.json())  # absent from their list

    r = await client.get(f"{API}/workspaces/{ws_id}", headers=other_headers)
    assert r.status_code == 403  # no membership

    r = await client.delete(f"{API}/workspaces/{ws_id}", headers=other_headers)
    assert r.status_code == 403


async def test_workspace_badges_persist(client):
    headers = await _bootstrap_admin(client)
    r = await client.post(
        f"{API}/workspaces", headers=headers, json={"name": {"en": "Demo"}}
    )
    ws_id = r.json()["id"]

    badges = [{"id": "b1", "label": "Prod", "color": "blue"}]
    r = await client.patch(
        f"{API}/workspaces/{ws_id}", headers=headers, json={"badges": badges}
    )
    assert r.status_code == 200
    assert r.json()["badges"] == badges

    # Persisted across a fresh read.
    r = await client.get(f"{API}/workspaces/{ws_id}", headers=headers)
    assert r.json()["badges"] == badges
