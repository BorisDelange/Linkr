from sqlalchemy import select

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


async def test_create_with_unknown_workspace_rejected(client):
    # An imported project may reference a workspace that doesn't exist on this
    # instance; the API must reject it cleanly (400) rather than 500 on the FK.
    headers = await _bootstrap_admin(client)
    r = await client.post(
        f"{API}/projects",
        headers=headers,
        json={"name": {"en": "X"}, "workspaceId": "does-not-exist"},
    )
    assert r.status_code == 400


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


async def test_create_stamps_author_from_creator(client):
    # A plain creation (no author snapshot in the payload) stamps the
    # authenticated user as the original author.
    headers = await _bootstrap_admin(client)
    r = await client.post(
        f"{API}/projects", headers=headers, json={"name": {"en": "P"}}
    )
    p = r.json()
    me = (await client.get(f"{API}/auth/me", headers=headers)).json()
    assert p["createdById"] == me["id"]
    assert p["createdBy"]  # non-empty display name


async def test_import_keeps_author_snapshot_when_no_local_match(client):
    # An imported project carries the original author's snapshot but no local
    # user matches (unknown ORCID) — keep the snapshot, createdById stays NULL.
    headers = await _bootstrap_admin(client)
    r = await client.post(
        f"{API}/projects",
        headers=headers,
        json={
            "name": {"en": "Imported"},
            "createdBy": "Original Author",
            "createdByDetails": {
                "firstName": "Original",
                "lastName": "Author",
                "orcid": "0000-0001-2345-6789",
            },
        },
    )
    p = r.json()
    assert p["createdBy"] == "Original Author"
    assert p["createdByDetails"]["orcid"] == "0000-0001-2345-6789"
    assert p["createdById"] is None


async def test_import_relinks_author_by_orcid(client, db):
    # An imported project whose author has an ORCID matching a local account
    # re-links createdById to that local user (live name resolution).
    headers = await _bootstrap_admin(client)
    db.add(
        User(
            username="carol",
            password_hash=hash_password("pw"),
            orcid="0000-0002-1111-2222",
        )
    )
    await db.commit()
    carol = (
        await db.execute(select(User).where(User.username == "carol"))
    ).scalars().first()

    r = await client.post(
        f"{API}/projects",
        headers=headers,
        json={
            "name": {"en": "Imported"},
            "createdBy": "Carol Elsewhere",
            "createdByDetails": {"orcid": "0000-0002-1111-2222"},
        },
    )
    p = r.json()
    assert p["createdById"] == carol.id
    # The frozen snapshot is still kept for round-trip export stability.
    assert p["createdBy"] == "Carol Elsewhere"


async def test_foreign_created_by_id_never_persisted(client):
    # A createdById in the payload is a foreign instance's local id — it must be
    # ignored, not written verbatim (which would corrupt the FK / attribution).
    headers = await _bootstrap_admin(client)
    r = await client.post(
        f"{API}/projects",
        headers=headers,
        json={
            "name": {"en": "Forged"},
            "createdById": 99999,
            "createdBy": "Ghost",
            "createdByDetails": {"orcid": "0000-0009-9999-9999"},
        },
    )
    # No local user 99999 and no ORCID match → NULL, snapshot kept.
    assert r.json()["createdById"] is None
    assert r.json()["createdBy"] == "Ghost"


async def test_lineage_identity_preserved_and_forkable(client):
    # lineage_id is a stable cross-instance identity, distinct from uid: the API
    # stores the client-supplied value verbatim (import keeps the same work), and
    # a PATCH can set parent_lineage_id (fork records its source).
    headers = await _bootstrap_admin(client)
    r = await client.post(
        f"{API}/projects",
        headers=headers,
        json={"name": {"en": "P"}, "uid": "proj-l", "lineageId": "lin-123"},
    )
    assert r.status_code == 201
    assert r.json()["lineageId"] == "lin-123"

    r = await client.patch(
        f"{API}/projects/proj-l",
        headers=headers,
        json={"lineageId": "lin-456", "parentLineageId": "lin-123"},
    )
    assert r.status_code == 200
    assert r.json()["lineageId"] == "lin-456"
    assert r.json()["parentLineageId"] == "lin-123"


async def test_created_at_preserved_on_import_and_restored_on_clone(client):
    # createdAt is immutable provenance that must survive a git round-trip. A create
    # keeps the supplied value; a later PATCH (the clone re-applying the repo's
    # authoritative project.json) restores it — so a git-pointer create that stamped
    # func.now() gets corrected to the real date instead of drifting each pull.
    headers = await _bootstrap_admin(client)
    r = await client.post(
        f"{API}/projects",
        headers=headers,
        json={"name": {"en": "P"}, "uid": "proj-ca", "createdAt": "2020-03-15T08:09:10.123Z"},
    )
    assert r.status_code == 201
    assert r.json()["createdAt"] == "2020-03-15T08:09:10.123Z"

    # A create WITHOUT createdAt stamps now; the clone-PATCH then restores the real date.
    r = await client.post(
        f"{API}/projects", headers=headers, json={"name": {"en": "Q"}, "uid": "proj-cb"}
    )
    assert r.status_code == 201 and r.json()["createdAt"] != "2019-01-02T03:04:05.000Z"
    r = await client.patch(
        f"{API}/projects/proj-cb",
        headers=headers,
        json={"createdAt": "2019-01-02T03:04:05.000Z"},
    )
    assert r.status_code == 200
    assert r.json()["createdAt"] == "2019-01-02T03:04:05.000Z"


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
