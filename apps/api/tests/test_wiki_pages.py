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


async def _make_page(client, headers, ws_id, page_id, **extra) -> dict:
    body = {
        "id": page_id,
        "workspaceId": ws_id,
        "title": {"en": "Page"},
        "content": {"en": "hello"},
        **extra,
    }
    r = await client.post(f"{API}/wiki-pages", headers=headers, json=body)
    return r


async def test_wiki_page_crud(client):
    headers = await _bootstrap_admin(client)
    ws_id = await _make_workspace(client, headers)

    r = await _make_page(
        client, headers, ws_id, "wp-1", slug="page", icon="book", sortOrder=3
    )
    assert r.status_code == 201
    p = r.json()
    assert "createdAt" in p and p["workspaceId"] == ws_id
    assert p["slug"] == "page" and p["icon"] == "book" and p["sortOrder"] == 3

    r = await client.get(
        f"{API}/wiki-pages?workspaceId={ws_id}", headers=headers
    )
    assert r.status_code == 200 and any(x["id"] == "wp-1" for x in r.json())

    r = await client.get(f"{API}/wiki-pages/wp-1", headers=headers)
    assert r.status_code == 200

    r = await client.patch(
        f"{API}/wiki-pages/wp-1", headers=headers, json={"title": {"en": "New"}}
    )
    assert r.status_code == 200 and r.json()["title"] == {"en": "New"}

    r = await client.delete(f"{API}/wiki-pages/wp-1", headers=headers)
    assert r.status_code == 204
    assert (await client.get(f"{API}/wiki-pages/wp-1", headers=headers)).status_code == 404


async def test_wiki_page_camelcase_rich_fields(client):
    headers = await _bootstrap_admin(client)
    ws_id = await _make_workspace(client, headers)
    r = await _make_page(
        client,
        headers,
        ws_id,
        "wp-rich",
        entityId="getting-started",
        verified=True,
        verifiedAt="2026-01-01T00:00:00Z",
        reviewDueAt="2026-06-01T00:00:00Z",
        history=[{"id": "s1", "content": "v1", "savedAt": "2026-01-01T00:00:00Z"}],
        createdBy="Alice",
        createdByDetails={"firstName": "Alice", "orcid": "0000-0002"},
    )
    assert r.status_code == 201
    p = r.json()
    assert p["entityId"] == "getting-started" and p["verified"] is True
    assert p["verifiedAt"] == "2026-01-01T00:00:00Z"
    assert p["reviewDueAt"] == "2026-06-01T00:00:00Z"
    assert p["history"][0]["content"] == "v1"
    assert p["createdBy"] == "Alice"
    assert p["createdByDetails"]["orcid"] == "0000-0002"


async def test_wiki_page_hierarchy(client):
    headers = await _bootstrap_admin(client)
    ws_id = await _make_workspace(client, headers)
    await _make_page(client, headers, ws_id, "parent", parentId=None)
    r = await _make_page(client, headers, ws_id, "child", parentId="parent")
    assert r.status_code == 201 and r.json()["parentId"] == "parent"

    # Re-parenting to top-level: explicit null clears it.
    r = await client.patch(
        f"{API}/wiki-pages/child", headers=headers, json={"parentId": None}
    )
    assert r.status_code == 200 and r.json()["parentId"] is None


async def test_delete_by_workspace(client):
    headers = await _bootstrap_admin(client)
    ws_id = await _make_workspace(client, headers)
    await _make_page(client, headers, ws_id, "a")
    await _make_page(client, headers, ws_id, "b")

    r = await client.delete(f"{API}/wiki-pages?workspaceId={ws_id}", headers=headers)
    assert r.status_code == 204
    r = await client.get(f"{API}/wiki-pages?workspaceId={ws_id}", headers=headers)
    assert r.json() == []


async def test_non_member_cannot_access_wiki(client, db):
    admin_headers = await _bootstrap_admin(client)
    ws_id = await _make_workspace(client, admin_headers)
    await _make_page(client, admin_headers, ws_id, "secret")

    other = await _create_user(db, client, "bob")

    # Cannot list, read, create, or delete in a workspace they're not a member of.
    assert (
        await client.get(f"{API}/wiki-pages?workspaceId={ws_id}", headers=other)
    ).status_code == 403
    assert (
        await client.get(f"{API}/wiki-pages/secret", headers=other)
    ).status_code == 403
    r = await _make_page(client, other, ws_id, "nope")
    assert r.status_code == 403
    assert (
        await client.delete(f"{API}/wiki-pages/secret", headers=other)
    ).status_code == 403


async def test_cascade_delete_with_workspace(client):
    headers = await _bootstrap_admin(client)
    ws_id = await _make_workspace(client, headers)
    await _make_page(client, headers, ws_id, "wp-cascade")

    assert (
        await client.delete(f"{API}/workspaces/{ws_id}", headers=headers)
    ).status_code == 204
    assert (
        await client.get(f"{API}/wiki-pages/wp-cascade", headers=headers)
    ).status_code == 404
