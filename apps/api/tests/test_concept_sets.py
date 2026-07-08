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


async def _concept_set(client, headers, ws: str, cid="cs1") -> dict:
    return (await client.post(f"{API}/concept-sets", headers=headers, json={
        "id": cid, "workspaceId": ws, "name": "Diabetes", "description": "",
        "expression": {"items": [{"conceptId": 201820}]}, "resolvedConceptIds": [201820, 4],
    })).json()


async def test_concept_set_crud(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    cs = await _concept_set(client, headers, ws)
    assert cs["workspaceId"] == ws and cs["name"] == "Diabetes"
    assert cs["expression"]["items"] == [{"conceptId": 201820}]
    assert cs["resolvedConceptIds"] == [201820, 4]

    listed = (await client.get(f"{API}/concept-sets?workspaceId={ws}", headers=headers)).json()
    assert [x["id"] for x in listed] == [cs["id"]]

    p = await client.patch(f"{API}/concept-sets/{cs['id']}", headers=headers,
                           json={"name": "T2DM", "resolvedConceptIds": None})
    assert p.json()["name"] == "T2DM" and p.json()["resolvedConceptIds"] is None

    assert (await client.delete(f"{API}/concept-sets/{cs['id']}", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/concept-sets/{cs['id']}", headers=headers)).status_code == 404


async def test_list_all_without_workspace_filter(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    await _concept_set(client, headers, ws)
    resp = await client.get(f"{API}/concept-sets", headers=headers)
    assert resp.status_code == 200 and len(resp.json()) == 1


async def test_delete_batch(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    await _concept_set(client, headers, ws, cid="cs1")
    await _concept_set(client, headers, ws, cid="cs2")
    await _concept_set(client, headers, ws, cid="cs3")

    r = await client.post(f"{API}/concept-sets/delete-batch", headers=headers,
                          json={"ids": ["cs1", "cs2"]})
    assert r.status_code == 204
    remaining = (await client.get(f"{API}/concept-sets?workspaceId={ws}", headers=headers)).json()
    assert [x["id"] for x in remaining] == ["cs3"]


async def test_non_member_cannot_access(client, db):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    cs = await _concept_set(client, admin, ws)
    other = await _create_user(db, client, "bob")
    assert (await client.get(f"{API}/concept-sets?workspaceId={ws}", headers=other)).status_code == 403
    assert (await client.delete(f"{API}/concept-sets/{cs['id']}", headers=other)).status_code == 403
