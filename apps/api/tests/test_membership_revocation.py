"""Project access follows workspace membership: removing someone from a
workspace ends their access to its projects, and a project hidden from a member
stays hidden on every route that names it."""

from app.core.security import create_kernel_token, hash_password
from app.models.user import User

API = "/api/v1"


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _user(db, client, username: str) -> tuple[int, dict]:
    u = User(username=username, password_hash=hash_password("pw-for-tests-only"), role="user")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw-for-tests-only"})
    return u.id, {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _workspace_and_project(client, admin) -> tuple[str, str]:
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "W"}})).json()["id"]
    uid = (await client.post(f"{API}/projects", headers=admin,
                             json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]
    return ws, uid


async def _set_ws_role(client, admin, ws, user_id, role):
    r = await client.put(f"{API}/workspaces/{ws}/members", headers=admin, json={"userId": user_id, "role": role})
    assert r.status_code == 200, r.text


async def _set_project_role(client, admin, uid, user_id, role):
    r = await client.put(f"{API}/projects/{uid}/members", headers=admin, json={"userId": user_id, "role": role})
    assert r.status_code == 200, r.text


async def _remove(client, admin, ws, user_id):
    r = await client.delete(f"{API}/workspaces/{ws}/members/{user_id}", headers=admin)
    assert r.status_code == 204, r.text


async def _lists(client, headers, uid) -> bool:
    return any(p["uid"] == uid for p in (await client.get(f"{API}/projects", headers=headers)).json())


async def test_a_removed_member_keeps_no_project_override(client, db):
    admin = await _admin(client)
    ws, uid = await _workspace_and_project(client, admin)
    viewer_id, viewer = await _user(db, client, "viewer_override")
    editor_id, editor = await _user(db, client, "editor_override")
    for user_id, role in ((viewer_id, "viewer"), (editor_id, "editor")):
        await _set_ws_role(client, admin, ws, user_id, "editor")
        await _set_project_role(client, admin, uid, user_id, role)
        await _remove(client, admin, ws, user_id)

    for headers in (viewer, editor):
        assert (await client.get(f"{API}/projects/{uid}", headers=headers)).status_code == 403
        assert (await client.get(f"{API}/cohorts?projectUid={uid}", headers=headers)).status_code == 403
        assert (await client.get(f"{API}/projects/{uid}/my-role", headers=headers)).json()["role"] is None
        assert not await _lists(client, headers, uid)
    r = await client.patch(f"{API}/projects/{uid}", headers=editor, json={"readme": "x"})
    assert r.status_code == 403


async def test_a_hiding_override_survives_removal_and_re_adding(client, db):
    admin = await _admin(client)
    ws, uid = await _workspace_and_project(client, admin)
    bob_id, bob = await _user(db, client, "bob")
    await _set_ws_role(client, admin, ws, bob_id, "editor")
    await _set_project_role(client, admin, uid, bob_id, "none")
    await _remove(client, admin, ws, bob_id)
    await _set_ws_role(client, admin, ws, bob_id, "editor")

    assert (await client.get(f"{API}/projects/{uid}", headers=bob)).status_code == 403
    assert not await _lists(client, bob, uid)


async def test_removing_a_member_leaves_other_people_and_workspaces_alone(client, db):
    admin = await _admin(client)
    ws, uid = await _workspace_and_project(client, admin)
    _, other_uid = await _workspace_and_project(client, admin)
    guest_id, guest = await _user(db, client, "guest")
    bob_id, bob = await _user(db, client, "bob")
    await _set_project_role(client, admin, uid, guest_id, "viewer")
    await _set_ws_role(client, admin, ws, bob_id, "editor")
    await _set_project_role(client, admin, other_uid, bob_id, "viewer")
    await _remove(client, admin, ws, bob_id)

    assert (await client.get(f"{API}/projects/{uid}", headers=guest)).status_code == 200
    assert (await client.get(f"{API}/projects/{other_uid}", headers=bob)).status_code == 200


async def test_the_client_library_refuses_a_member_the_project_is_hidden_from(client, db):
    admin = await _admin(client)
    ws, uid = await _workspace_and_project(client, admin)
    hidden_id, hidden = await _user(db, client, "hidden")
    kept_id, kept = await _user(db, client, "kept")
    await _set_ws_role(client, admin, ws, hidden_id, "editor")
    await _set_ws_role(client, admin, ws, kept_id, "viewer")
    kernel = create_kernel_token(hidden_id, "hidden", "user", uid, via="web")
    await _set_project_role(client, admin, uid, hidden_id, "none")

    url = f"{API}/projects/{uid}/client/databases"
    assert (await client.get(url, headers=hidden)).status_code == 403
    assert (await client.get(url, headers={"Authorization": f"Bearer {kernel}"})).status_code == 403
    assert (await client.get(url, headers=kept)).status_code == 200
