from app.core.security import hash_password
from app.models.user import User

API = "/api/v1"


async def _bootstrap_admin(client) -> dict:
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw"}
    )
    r = await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "pw"}
    )
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _create_user(db, client, username: str, role: str = "user") -> dict:
    db.add(User(username=username, password_hash=hash_password("pw"), role=role))
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


async def test_project_crud_under_workspace(client):
    headers = await _bootstrap_admin(client)
    ws_id = await _make_workspace(client, headers)

    r = await client.post(
        f"{API}/projects",
        headers=headers,
        json={"name": {"en": "P"}, "workspaceId": ws_id, "projectId": "p-1"},
    )
    assert r.status_code == 201
    p = r.json()
    assert "createdAt" in p and p["workspaceId"] == ws_id and p["projectId"] == "p-1"
    uid = p["uid"]

    r = await client.get(f"{API}/projects", headers=headers)
    assert any(x["uid"] == uid for x in r.json())

    r = await client.get(f"{API}/projects/{uid}", headers=headers)
    assert r.status_code == 200

    r = await client.patch(
        f"{API}/projects/{uid}", headers=headers, json={"name": {"en": "P2"}}
    )
    assert r.status_code == 200 and r.json()["name"] == {"en": "P2"}

    r = await client.delete(f"{API}/projects/{uid}", headers=headers)
    assert r.status_code == 204


async def test_client_supplied_uid_kept(client):
    headers = await _bootstrap_admin(client)
    r = await client.post(
        f"{API}/projects", headers=headers, json={"uid": "proj-fixed", "name": {"en": "X"}}
    )
    assert r.status_code == 201 and r.json()["uid"] == "proj-fixed"


async def test_non_member_cannot_access_project(client, db):
    admin_headers = await _bootstrap_admin(client)
    ws_id = await _make_workspace(client, admin_headers)
    r = await client.post(
        f"{API}/projects",
        headers=admin_headers,
        json={"name": {"en": "Secret"}, "workspaceId": ws_id},
    )
    uid = r.json()["uid"]

    other = await _create_user(db, client, "bob")

    # Absent from their list.
    r = await client.get(f"{API}/projects", headers=other)
    assert all(x["uid"] != uid for x in r.json())

    # 403 on access (not a workspace member).
    assert (await client.get(f"{API}/projects/{uid}", headers=other)).status_code == 403
    assert (await client.delete(f"{API}/projects/{uid}", headers=other)).status_code == 403

    # Cannot create in a workspace they're not an editor of.
    r = await client.post(
        f"{API}/projects",
        headers=other,
        json={"name": {"en": "Nope"}, "workspaceId": ws_id},
    )
    assert r.status_code == 403


async def test_cascade_delete_with_workspace(client, db):
    headers = await _bootstrap_admin(client)
    ws_id = await _make_workspace(client, headers)
    r = await client.post(
        f"{API}/projects",
        headers=headers,
        json={"name": {"en": "Child"}, "workspaceId": ws_id},
    )
    uid = r.json()["uid"]

    # Deleting the workspace cascades to its projects.
    assert (await client.delete(f"{API}/workspaces/{ws_id}", headers=headers)).status_code == 204
    r = await client.get(f"{API}/projects/{uid}", headers=headers)
    assert r.status_code == 404
