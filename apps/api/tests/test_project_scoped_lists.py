"""GET /pipelines and GET /concept-lists without a projectUid: only the projects
the caller may read, as with a projectUid."""

from app.core.security import hash_password
from app.models.user import User

API = "/api/v1"


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _viewer(client, db) -> tuple[int, dict]:
    user = User(username="viewer", password_hash=hash_password("pw-for-tests-only"), role="user")
    db.add(user)
    await db.commit()
    r = await client.post(f"{API}/auth/login", json={"username": "viewer", "password": "pw-for-tests-only"})
    return user.id, {"Authorization": f"Bearer {r.json()['access_token']}"}


async def test_unscoped_lists_leave_out_a_project_overridden_to_none(client, db):
    admin = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "WS"}})).json()["id"]
    seen, hidden = [
        (await client.post(f"{API}/projects", headers=admin, json={"name": {"en": n}, "workspaceId": ws})).json()["uid"]
        for n in ("seen", "hidden")
    ]
    for uid in (seen, hidden):
        assert (await client.post(f"{API}/pipelines", headers=admin, json={"id": f"pp-{uid}", "projectUid": uid})).status_code == 201
        assert (await client.post(f"{API}/concept-lists", headers=admin, json={"id": f"cl-{uid}", "projectUid": uid})).status_code == 201
    viewer_id, viewer = await _viewer(client, db)
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin, json={"userId": viewer_id, "role": "viewer"})
    await client.put(f"{API}/projects/{hidden}/members", headers=admin, json={"userId": viewer_id, "role": "none"})

    pipelines = (await client.get(f"{API}/pipelines", headers=viewer)).json()
    assert [p["projectUid"] for p in pipelines] == [seen]
    lists = (await client.get(f"{API}/concept-lists", headers=viewer)).json()
    assert [c["projectUid"] for c in lists] == [seen]
    assert len((await client.get(f"{API}/pipelines", headers=admin)).json()) == 2
