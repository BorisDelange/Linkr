import pytest

from app.core.permissions import has_permission
from app.core.security import hash_password
from app.models.user import User
from app.models.workspace_member import WorkspaceMember

API = "/api/v1"


async def _bootstrap_admin(client) -> dict:
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw"}
    )
    r = await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "pw"}
    )
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _login(client, username, password="pw") -> dict:
    r = await client.post(
        f"{API}/auth/login", json={"username": username, "password": password}
    )
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def test_default_roles_seeded(client, seed_roles):
    headers = await _bootstrap_admin(client)
    r = await client.get(f"{API}/roles", headers=headers)
    assert r.status_code == 200
    names = {x["name"] for x in r.json()}
    assert {"viewer", "editor", "owner", "admin", "user"} <= names
    editor = next(x for x in r.json() if x["name"] == "editor")
    assert editor["isSystem"] is True
    assert "projects:write" in editor["permissions"]
    assert "projects:delete" not in editor["permissions"]


async def test_permissions_catalogue(client):
    headers = await _bootstrap_admin(client)
    r = await client.get(f"{API}/roles/permissions", headers=headers)
    assert r.status_code == 200
    assert "projects:write" in r.json() and "users:delete" in r.json()


async def test_custom_role_crud(client):
    headers = await _bootstrap_admin(client)
    r = await client.post(
        f"{API}/roles",
        headers=headers,
        json={
            "name": "analyst",
            "label": {"en": "Analyst"},
            "permissions": ["projects:read", "datasets:read"],
        },
    )
    assert r.status_code == 201
    role = r.json()
    assert role["isSystem"] is False and role["permissions"] == ["projects:read", "datasets:read"]
    rid = role["id"]

    r = await client.patch(
        f"{API}/roles/{rid}",
        headers=headers,
        json={"permissions": ["projects:read", "projects:write"]},
    )
    assert r.status_code == 200 and "projects:write" in r.json()["permissions"]

    assert (await client.delete(f"{API}/roles/{rid}", headers=headers)).status_code == 204


async def test_unknown_permission_rejected(client):
    headers = await _bootstrap_admin(client)
    r = await client.post(
        f"{API}/roles",
        headers=headers,
        json={"name": "bad", "permissions": ["projects:teleport"]},
    )
    assert r.status_code == 400


async def test_system_role_not_deletable(client, seed_roles):
    headers = await _bootstrap_admin(client)
    roles = (await client.get(f"{API}/roles", headers=headers)).json()
    editor = next(x for x in roles if x["name"] == "editor")
    assert (await client.delete(f"{API}/roles/{editor['id']}", headers=headers)).status_code == 400


async def test_role_in_use_not_deletable(client, db, seed_roles):
    headers = await _bootstrap_admin(client)
    r = await client.post(
        f"{API}/roles", headers=headers, json={"name": "temp", "permissions": []}
    )
    rid = r.json()["id"]

    # Assign the role to a member, then deletion is blocked. Use a distinct user
    # so we don't collide with the workspace creator (auto-added as owner).
    ws = await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "W"}})
    ws_id = ws.json()["id"]
    bob = User(username="bob", password_hash=hash_password("pw"), role="user")
    db.add(bob)
    await db.commit()
    await db.refresh(bob)
    db.add(WorkspaceMember(workspace_id=ws_id, user_id=bob.id, role="temp"))
    await db.commit()
    assert (await client.delete(f"{API}/roles/{rid}", headers=headers)).status_code == 400


async def test_roles_admin_only(client, db):
    await _bootstrap_admin(client)
    db.add(User(username="bob", password_hash=hash_password("pw"), role="user"))
    await db.commit()
    bob = await _login(client, "bob")
    assert (await client.get(f"{API}/roles", headers=bob)).status_code == 403


@pytest.mark.asyncio
async def test_has_permission_resolves_role(client, db, seed_roles):
    """has_permission consults the member's Role permission list; admin bypasses."""
    # Create a workspace owned by admin (user id 1).
    headers = await _bootstrap_admin(client)
    ws = await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "W"}})
    ws_id = ws.json()["id"]

    bob = User(username="bob", password_hash=hash_password("pw"), role="user")
    db.add(bob)
    await db.commit()
    await db.refresh(bob)
    db.add(WorkspaceMember(workspace_id=ws_id, user_id=bob.id, role="viewer"))
    await db.commit()

    assert await has_permission(db, ws_id, bob, "projects:read") is True
    assert await has_permission(db, ws_id, bob, "projects:write") is False

    admin = await db.get(User, 1)
    assert await has_permission(db, ws_id, admin, "projects:delete") is True
