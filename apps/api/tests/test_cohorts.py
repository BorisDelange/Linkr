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


async def _project(client, headers) -> str:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    return (await client.post(f"{API}/projects", headers=headers, json={
        "name": {"en": "P"}, "workspaceId": ws,
    })).json()["uid"]


async def _cohort(client, headers, project_uid: str, cid="c1") -> dict:
    return (await client.post(f"{API}/cohorts", headers=headers, json={
        "id": cid, "projectUid": project_uid, "name": "Adults", "level": "patient",
        "criteriaTree": {"type": "group", "op": "and", "children": []},
    })).json()


async def test_cohort_crud(client):
    headers = await _admin_headers(client)
    proj = await _project(client, headers)
    c = await _cohort(client, headers, proj)
    assert c["projectUid"] == proj and c["level"] == "patient"
    assert c["criteriaTree"]["op"] == "and" and c["schemaVersion"] == 3

    listed = (await client.get(f"{API}/cohorts?projectUid={proj}", headers=headers)).json()
    assert [x["id"] for x in listed] == [c["id"]]

    r = await client.patch(f"{API}/cohorts/{c['id']}", headers=headers,
                           json={"name": "Adults >18", "resultCount": 42})
    assert r.json()["name"] == "Adults >18" and r.json()["resultCount"] == 42

    assert (await client.delete(f"{API}/cohorts/{c['id']}", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/cohorts/{c['id']}", headers=headers)).status_code == 404


async def test_list_all_without_project_filter(client):
    # The store loads cohorts app-wide (no projectUid) — must not 422.
    headers = await _admin_headers(client)
    proj = await _project(client, headers)
    await _cohort(client, headers, proj)
    r = await client.get(f"{API}/cohorts", headers=headers)
    assert r.status_code == 200
    assert len(r.json()) == 1


async def test_non_member_cannot_access(client, db):
    admin = await _admin_headers(client)
    proj = await _project(client, admin)
    c = await _cohort(client, admin, proj)

    other = await _create_user(db, client, "bob")
    assert (await client.get(f"{API}/cohorts?projectUid={proj}", headers=other)).status_code == 403
    assert (await client.get(f"{API}/cohorts/{c['id']}", headers=other)).status_code == 403
    assert (await client.delete(f"{API}/cohorts/{c['id']}", headers=other)).status_code == 403
