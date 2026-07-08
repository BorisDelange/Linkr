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


async def test_global_plugin_no_workspace(client):
    headers = await _admin_headers(client)
    # A global plugin (no workspaceId) is allowed and listed without a filter.
    g = (await client.post(f"{API}/user-plugins", headers=headers, json={
        "id": "g1", "files": {"main.py": "x=1"},
    })).json()
    assert g["workspaceId"] is None

    all_plugins = (await client.get(f"{API}/user-plugins", headers=headers)).json()
    assert "g1" in [x["id"] for x in all_plugins]
