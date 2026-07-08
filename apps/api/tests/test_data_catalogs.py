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


async def _workspace(client, headers) -> str:
    return (
        await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})
    ).json()["id"]


async def _catalog(client, headers, ws: str, cid="cat1") -> dict:
    return (await client.post(f"{API}/data-catalogs", headers=headers, json={
        "id": cid, "workspaceId": ws, "name": {"en": "Catalog"}, "description": {},
        "dataSourceId": "src-1", "dimensions": [{"type": "age"}], "anonymization": {"mode": "none"},
    })).json()


async def test_catalog_crud(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    c = await _catalog(client, headers, ws)
    assert c["workspaceId"] == ws and c["status"] == "draft"
    assert c["dimensions"] == [{"type": "age"}] and c["anonymization"] == {"mode": "none"}

    listed = (await client.get(f"{API}/data-catalogs?workspaceId={ws}", headers=headers)).json()
    assert [x["id"] for x in listed] == [c["id"]]

    p = await client.patch(f"{API}/data-catalogs/{c['id']}", headers=headers,
                           json={"status": "computing", "lastComputedAt": "2026-07-08T00:00:00Z"})
    assert p.json()["status"] == "computing"

    assert (await client.delete(f"{API}/data-catalogs/{c['id']}", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/data-catalogs/{c['id']}", headers=headers)).status_code == 404


async def test_list_all_without_workspace_filter(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    await _catalog(client, headers, ws)
    resp = await client.get(f"{API}/data-catalogs", headers=headers)
    assert resp.status_code == 200 and len(resp.json()) == 1


async def test_non_member_cannot_access(client, db):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    c = await _catalog(client, admin, ws)
    other = await _create_user(db, client, "bob")
    assert (await client.get(f"{API}/data-catalogs?workspaceId={ws}", headers=other)).status_code == 403
    assert (await client.delete(f"{API}/data-catalogs/{c['id']}", headers=other)).status_code == 403
