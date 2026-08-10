from app.core.security import hash_password
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


async def _workspace(client, headers) -> str:
    return (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]


async def _project(client, headers, ws) -> str:
    return (await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]


PNG = b"\x89PNG\r\n\x1a\nhello-bytes"


# --- README attachments -----------------------------------------------------


async def test_readme_attachment_roundtrip(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    proj = await _project(client, headers, ws)

    qs = f"id=a1&ownerType=project&ownerId={proj}&fileName=logo.png&mimeType=image/png"
    r = await client.post(f"{API}/readme-attachments?{qs}", headers=headers, content=PNG)
    assert r.status_code == 201
    assert r.json()["fileName"] == "logo.png" and r.json()["fileSize"] == len(PNG)
    # workspaceId is resolved server-side from the owner, never taken from the client.
    assert r.json()["ownerType"] == "project" and r.json()["workspaceId"] == ws

    listed = (await client.get(f"{API}/readme-attachments?ownerType=project&ownerId={proj}", headers=headers)).json()
    assert [a["id"] for a in listed] == ["a1"]

    blob = await client.get(f"{API}/readme-attachments/a1/blob", headers=headers)
    assert blob.status_code == 200 and blob.content == PNG
    assert blob.headers["x-file-name"] == "logo.png"

    assert (await client.delete(f"{API}/readme-attachments/a1", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/readme-attachments/a1/blob", headers=headers)).status_code == 404


async def test_readme_dedup_and_ref_counting(client):
    # Two attachments with identical bytes share one blob; deleting one must not
    # remove the bytes still referenced by the other.
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    proj = await _project(client, headers, ws)

    await client.post(f"{API}/readme-attachments?id=d1&ownerType=project&ownerId={proj}&fileName=x.png&mimeType=image/png", headers=headers, content=PNG)
    await client.post(f"{API}/readme-attachments?id=d2&ownerType=project&ownerId={proj}&fileName=y.png&mimeType=image/png", headers=headers, content=PNG)

    await client.delete(f"{API}/readme-attachments/d1", headers=headers)
    # d2's bytes must still be served.
    blob = await client.get(f"{API}/readme-attachments/d2/blob", headers=headers)
    assert blob.status_code == 200 and blob.content == PNG


async def test_readme_workspace_scope(client):
    # README attachments can also be workspace-scoped (workspace has a README too).
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)

    qs = f"id=w1&ownerType=workspace&ownerId={ws}&fileName=ws.png&mimeType=image/png"
    r = await client.post(f"{API}/readme-attachments?{qs}", headers=headers, content=PNG)
    assert r.status_code == 201
    assert r.json()["workspaceId"] == ws and r.json()["ownerType"] == "workspace"

    listed = (await client.get(f"{API}/readme-attachments?ownerType=workspace&ownerId={ws}", headers=headers)).json()
    assert [a["id"] for a in listed] == ["w1"]

    blob = await client.get(f"{API}/readme-attachments/w1/blob", headers=headers)
    assert blob.content == PNG

    # Batch delete by owner.
    assert (await client.delete(f"{API}/readme-attachments?ownerType=workspace&ownerId={ws}", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/readme-attachments?ownerType=workspace&ownerId={ws}", headers=headers)).json() == []


async def test_readme_workspace_batch_delete_spans_owner_types(client):
    # ?workspaceId= wipes every attachment of the workspace, whatever owns it.
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    proj = await _project(client, headers, ws)
    pipe = (await client.post(f"{API}/etl-pipelines", headers=headers, json={
        "id": "pipe-1", "workspaceId": ws, "name": {"en": "P"},
    })).json()["id"]

    for att_id, owner_type, owner_id in (
        ("m1", "workspace", ws), ("m2", "project", proj), ("m3", "etl-pipeline", pipe),
    ):
        r = await client.post(
            f"{API}/readme-attachments?id={att_id}&ownerType={owner_type}"
            f"&ownerId={owner_id}&fileName={att_id}.png&mimeType=image/png",
            headers=headers, content=PNG + att_id.encode(),
        )
        assert r.status_code == 201, r.text
        assert r.json()["workspaceId"] == ws

    assert (await client.delete(f"{API}/readme-attachments?workspaceId={ws}", headers=headers)).status_code == 204
    for owner_type, owner_id in (("workspace", ws), ("project", proj), ("etl-pipeline", pipe)):
        assert (await client.get(
            f"{API}/readme-attachments?ownerType={owner_type}&ownerId={owner_id}", headers=headers
        )).json() == []


async def test_readme_entity_owner_cascade_on_delete(client):
    # The polymorphic owner has no FK, so the entity's delete must clean up.
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    coll = (await client.post(f"{API}/sql-script-collections", headers=headers, json={
        "id": "coll-1", "workspaceId": ws, "name": {"en": "C"},
    })).json()["id"]

    r = await client.post(
        f"{API}/readme-attachments?id=c1&ownerType=sql-collection&ownerId={coll}"
        "&fileName=c.png&mimeType=image/png",
        headers=headers, content=PNG,
    )
    assert r.status_code == 201, r.text

    assert (await client.delete(f"{API}/sql-script-collections/{coll}", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/readme-attachments/c1/blob", headers=headers)).status_code == 404


async def test_readme_unknown_owner_type_and_missing_owner(client):
    headers = await _admin_headers(client)
    assert (await client.get(f"{API}/readme-attachments?ownerType=nope&ownerId=x", headers=headers)).status_code == 422
    assert (await client.get(f"{API}/readme-attachments", headers=headers)).status_code == 422
    assert (await client.get(f"{API}/readme-attachments?ownerType=etl-pipeline&ownerId=ghost", headers=headers)).status_code == 404
    assert (await client.get(f"{API}/readme-attachments?ownerType=project&ownerId=ghost", headers=headers)).status_code == 404


async def test_readme_non_member_forbidden(client, db):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    proj = await _project(client, admin, ws)
    await client.post(f"{API}/readme-attachments?id=z1&ownerType=project&ownerId={proj}&fileName=x.png&mimeType=image/png", headers=admin, content=PNG)

    other = await _create_user(db, client, "bob")
    assert (await client.get(f"{API}/readme-attachments?ownerType=project&ownerId={proj}", headers=other)).status_code == 403
    assert (await client.get(f"{API}/readme-attachments/z1/blob", headers=other)).status_code == 403


async def test_readme_entity_owner_permission_is_its_own_resource(client, db):
    # An ETL pipeline's README is governed by `etl`, not the workspace summary.
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    pipe = (await client.post(f"{API}/etl-pipelines", headers=admin, json={
        "id": "pipe-perm", "workspaceId": ws, "name": {"en": "P"},
    })).json()["id"]

    other = await _create_user(db, client, "carol")
    assert (await client.get(
        f"{API}/readme-attachments?ownerType=etl-pipeline&ownerId={pipe}", headers=other
    )).status_code == 403


# --- Wiki attachments -------------------------------------------------------


async def _wiki_page(client, headers, ws, pid="w1") -> str:
    return (await client.post(f"{API}/wiki-pages", headers=headers, json={
        "id": pid, "workspaceId": ws, "parentId": None, "title": {"en": "Page"},
        "slug": "page", "content": {"en": ""}, "sortOrder": 0,
    })).json()["id"]


async def test_wiki_attachment_roundtrip_and_scopes(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    page = await _wiki_page(client, headers, ws)

    qs = f"id=wa1&pageId={page}&workspaceId={ws}&fileName=pic.png&mimeType=image/png"
    r = await client.post(f"{API}/wiki-attachments?{qs}", headers=headers, content=PNG)
    assert r.status_code == 201

    by_page = (await client.get(f"{API}/wiki-attachments?pageId={page}", headers=headers)).json()
    assert [a["id"] for a in by_page] == ["wa1"]
    by_ws = (await client.get(f"{API}/wiki-attachments?workspaceId={ws}", headers=headers)).json()
    assert [a["id"] for a in by_ws] == ["wa1"]

    blob = await client.get(f"{API}/wiki-attachments/wa1/blob", headers=headers)
    assert blob.content == PNG

    # Batch delete by page.
    assert (await client.delete(f"{API}/wiki-attachments?pageId={page}", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/wiki-attachments?pageId={page}", headers=headers)).json() == []


async def test_wiki_cascade_on_page_delete(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    page = await _wiki_page(client, headers, ws)
    await client.post(f"{API}/wiki-attachments?id=wc1&pageId={page}&workspaceId={ws}&fileName=p.png&mimeType=image/png", headers=headers, content=PNG)

    # Deleting the page cascades the attachment row (FK ondelete=CASCADE).
    assert (await client.delete(f"{API}/wiki-pages/{page}", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/wiki-attachments/wc1/blob", headers=headers)).status_code == 404
