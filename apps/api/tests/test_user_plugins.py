from app.core.security import hash_password
from app.models.user import User

API = "/api/v1"


async def _admin_headers(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _workspace(client, headers) -> str:
    return (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]


async def test_plugin_crud_workspace_scoped(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = (await client.post(f"{API}/user-plugins", headers=headers, json={
        "id": "pl1", "workspaceId": ws, "files": {"main.R": "print('hi')", "ui.R": "# ui"},
    })).json()
    assert p["workspaceId"] == ws and p["files"]["main.R"] == "print('hi')"

    listed = (await client.get(f"{API}/user-plugins?workspaceId={ws}", headers=headers)).json()
    assert [x["id"] for x in listed] == ["pl1"]

    r = await client.patch(f"{API}/user-plugins/pl1", headers=headers,
                           json={"files": {"main.R": "print('bye')"}})
    assert r.json()["files"] == {"main.R": "print('bye')"}

    assert (await client.delete(f"{API}/user-plugins/pl1", headers=headers)).status_code == 204


async def test_plugin_requires_a_workspace(client):
    """Plugins are strictly workspace-scoped: creating one without a workspace is
    a validation error (no more instance-wide/global plugins)."""
    headers = await _admin_headers(client)
    r = await client.post(f"{API}/user-plugins", headers=headers, json={
        "id": "g1", "files": {"main.py": "x=1"},
    })
    assert r.status_code == 422


async def test_non_member_cannot_manage_workspace_plugin(client, db):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    await client.post(f"{API}/user-plugins", headers=admin, json={
        "id": "pl1", "workspaceId": ws, "files": {"main.py": "x=1"},
    })

    # An unrelated user can neither see nor edit nor delete the workspace's plugin.
    db.add(User(username="bob", password_hash=hash_password("pw"), role="user"))
    await db.commit()
    bob = {"Authorization": f"Bearer {(await client.post(f'{API}/auth/login', json={'username': 'bob', 'password': 'pw'})).json()['access_token']}"}

    assert (await client.get(f"{API}/user-plugins?workspaceId={ws}", headers=bob)).status_code == 403
    assert (await client.patch(f"{API}/user-plugins/pl1", headers=bob,
            json={"files": {"main.py": "y=2"}})).status_code == 403
    assert (await client.delete(f"{API}/user-plugins/pl1", headers=bob)).status_code == 403
    # And an unfiltered list doesn't leak it to him.
    assert "pl1" not in [x["id"] for x in (await client.get(f"{API}/user-plugins", headers=bob)).json()]
