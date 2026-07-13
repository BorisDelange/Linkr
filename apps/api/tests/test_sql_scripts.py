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


async def _collection(client, headers, ws: str, cid="c1") -> dict:
    return (await client.post(f"{API}/sql-script-collections", headers=headers, json={
        "id": cid, "workspaceId": ws, "name": {"en": "Queries"}, "description": {},
    })).json()


async def test_collection_crud(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    c = await _collection(client, headers, ws)
    assert c["workspaceId"] == ws and c["name"]["en"] == "Queries"

    listed = (await client.get(f"{API}/sql-script-collections?workspaceId={ws}", headers=headers)).json()
    assert [x["id"] for x in listed] == [c["id"]]

    r = await client.patch(f"{API}/sql-script-collections/{c['id']}", headers=headers,
                           json={"name": {"en": "Cohort SQL"}})
    assert r.json()["name"]["en"] == "Cohort SQL"

    assert (await client.delete(f"{API}/sql-script-collections/{c['id']}", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/sql-script-collections/{c['id']}", headers=headers)).status_code == 404


async def test_organization_snapshot_persisted(client):
    # A standalone entity carries a frozen organization provenance snapshot
    # (inlined at export). It must round-trip through create → response → get,
    # multilingual fields included, as an opaque JSON blob.
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    org = {
        "id": "org-42",
        "name": {"en": "Acme Hospital", "fr": "Hôpital Acme"},
        "type": "hospital",
        "location": {"en": "Rennes", "fr": "Rennes"},
        "referenceId": "https://ror.org/xxxx",
    }
    c = (await client.post(f"{API}/sql-script-collections", headers=headers, json={
        "id": "c-org", "workspaceId": ws, "name": {"en": "Q"}, "description": {},
        "organization": org,
    })).json()
    assert c["organization"] == org

    got = (await client.get(f"{API}/sql-script-collections/{c['id']}", headers=headers)).json()
    assert got["organization"]["name"] == {"en": "Acme Hospital", "fr": "Hôpital Acme"}
    assert got["organization"]["referenceId"] == "https://ror.org/xxxx"


async def test_list_all_without_workspace_filter(client):
    # The store loads collections app-wide (no workspaceId) — must not 422.
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    await _collection(client, headers, ws)
    r = await client.get(f"{API}/sql-script-collections", headers=headers)
    assert r.status_code == 200
    assert len(r.json()) == 1


async def test_file_tree_crud_and_cascade(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    c = await _collection(client, headers, ws)

    folder = (await client.post(f"{API}/sql-script-files", headers=headers, json={
        "id": "f1", "collectionId": c["id"], "name": "cohorts", "type": "folder", "order": 0,
    })).json()
    file = (await client.post(f"{API}/sql-script-files", headers=headers, json={
        "id": "f2", "collectionId": c["id"], "name": "a.sql", "type": "file",
        "parentId": folder["id"], "content": "SELECT 1", "order": 1,
    })).json()
    assert file["parentId"] == "f1" and file["content"] == "SELECT 1"

    files = (await client.get(f"{API}/sql-script-collections/{c['id']}/files", headers=headers)).json()
    assert {f["id"] for f in files} == {"f1", "f2"}

    r = await client.patch(f"{API}/sql-script-files/{file['id']}", headers=headers,
                           json={"content": "SELECT 2"})
    assert r.json()["content"] == "SELECT 2"

    # Deleting the collection cascades to its files.
    assert (await client.delete(f"{API}/sql-script-collections/{c['id']}", headers=headers)).status_code == 204
    # A new collection reusing nothing: the old files are gone.
    c2 = await _collection(client, headers, ws, cid="c2")
    assert (await client.get(f"{API}/sql-script-collections/{c2['id']}/files", headers=headers)).json() == []


async def test_delete_files_for_collection(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    c = await _collection(client, headers, ws)
    await client.post(f"{API}/sql-script-files", headers=headers, json={
        "id": "f1", "collectionId": c["id"], "name": "a.sql", "type": "file", "order": 0,
    })
    assert (await client.delete(f"{API}/sql-script-collections/{c['id']}/files", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/sql-script-collections/{c['id']}/files", headers=headers)).json() == []


async def test_non_member_cannot_access(client, db):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    c = await _collection(client, admin, ws)

    other = await _create_user(db, client, "bob")
    assert (await client.get(f"{API}/sql-script-collections?workspaceId={ws}", headers=other)).status_code == 403
    assert (await client.get(f"{API}/sql-script-collections/{c['id']}", headers=other)).status_code == 403
    assert (await client.delete(f"{API}/sql-script-collections/{c['id']}", headers=other)).status_code == 403
