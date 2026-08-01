"""Execution session routes: per-user named sessions, isolation, delete guard."""

from app.core.security import hash_password
from app.models.user import User
from app.models.workspace_member import WorkspaceMember

API = "/api/v1"


async def _admin_headers(client) -> dict:
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw"}
    )
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _project(client, headers) -> tuple[str, str]:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    uid = (
        await client.post(
            f"{API}/projects",
            headers=headers,
            json={"uid": "proj-1", "name": {"en": "P"}, "workspaceId": ws},
        )
    ).json()["uid"]
    return uid, ws


async def _member(db, client, username: str, ws: str) -> dict:
    db.add(User(username=username, password_hash=hash_password("pw"), role="user"))
    await db.commit()
    from sqlalchemy import select
    user = (await db.execute(select(User).where(User.username == username))).scalar_one()
    db.add(WorkspaceMember(workspace_id=ws, user_id=user.id, role="editor"))
    await db.commit()
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def test_create_list_delete(client):
    headers = await _admin_headers(client)
    uid, _ws = await _project(client, headers)

    created = await client.post(
        f"{API}/execute/sessions",
        headers=headers,
        json={"id": "sess-1", "projectUid": uid, "language": "r", "name": "Analysis"},
    )
    assert created.status_code == 201
    assert created.json()["name"] == "Analysis"
    assert created.json()["language"] == "r"

    listed = (await client.get(f"{API}/execute/sessions?projectUid={uid}", headers=headers)).json()
    assert [s["id"] for s in listed] == ["sess-1"]

    assert (await client.delete(f"{API}/execute/sessions/sess-1", headers=headers)).status_code == 204
    listed = (await client.get(f"{API}/execute/sessions?projectUid={uid}", headers=headers)).json()
    assert listed == []


async def test_sessions_are_language_scoped(client):
    """A session created for one language is only listed when filtering by it."""
    headers = await _admin_headers(client)
    uid, _ws = await _project(client, headers)

    await client.post(
        f"{API}/execute/sessions",
        headers=headers,
        json={"id": "py-1", "projectUid": uid, "language": "python", "name": "Py"},
    )
    await client.post(
        f"{API}/execute/sessions",
        headers=headers,
        json={"id": "r-1", "projectUid": uid, "language": "r", "name": "R"},
    )

    r_only = (
        await client.get(f"{API}/execute/sessions?projectUid={uid}&language=r", headers=headers)
    ).json()
    assert [s["id"] for s in r_only] == ["r-1"]

    py_only = (
        await client.get(f"{API}/execute/sessions?projectUid={uid}&language=python", headers=headers)
    ).json()
    assert [s["id"] for s in py_only] == ["py-1"]

    # No filter → both.
    both = (await client.get(f"{API}/execute/sessions?projectUid={uid}", headers=headers)).json()
    assert {s["id"] for s in both} == {"py-1", "r-1"}


async def test_sessions_are_per_user(client, db):
    admin = await _admin_headers(client)
    uid, ws = await _project(client, admin)
    await client.post(
        f"{API}/execute/sessions", headers=admin, json={"id": "a1", "projectUid": uid, "name": "A"}
    )

    # Bob is a workspace member (can access the project) but sees none of admin's
    # sessions — they are per-user.
    other = await _member(db, client, "bob", ws)
    listed = (await client.get(f"{API}/execute/sessions?projectUid={uid}", headers=other)).json()
    assert listed == []


async def test_cannot_delete_another_users_session(client, db):
    admin = await _admin_headers(client)
    uid, ws = await _project(client, admin)
    await client.post(
        f"{API}/execute/sessions", headers=admin, json={"id": "a1", "projectUid": uid, "name": "A"}
    )
    other = await _member(db, client, "bob", ws)
    r = await client.delete(f"{API}/execute/sessions/a1", headers=other)
    assert r.status_code == 403
