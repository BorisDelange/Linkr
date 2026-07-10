from tests.test_dashboards import _admin_headers, _project

API = "/api/v1"


async def _workspace(client, headers):
    return (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]


async def test_project_readme_notes_persist_as_object(client):
    headers = await _admin_headers(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    proj = (await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]

    r = await client.patch(f"{API}/projects/{proj}", headers=headers, json={
        "readme": {"en": "# Hello", "fr": "# Bonjour"},
        "notes": {"en": "note"},
    })
    assert r.status_code == 200
    assert r.json()["readme"] == {"en": "# Hello", "fr": "# Bonjour"}
    assert r.json()["notes"] == {"en": "note"}

    # Persisted: re-fetch returns the object, not a stringified dict.
    got = (await client.get(f"{API}/projects/{proj}", headers=headers)).json()
    assert got["readme"] == {"en": "# Hello", "fr": "# Bonjour"}


async def test_workspace_readme_persists_as_object(client):
    headers = await _admin_headers(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    r = await client.patch(f"{API}/workspaces/{ws}", headers=headers, json={"readme": {"en": "# WS readme"}})
    assert r.status_code == 200
    assert r.json()["readme"] == {"en": "# WS readme"}


async def test_legacy_string_readme_tolerated(client):
    # A bare string (legacy) must not 422.
    headers = await _admin_headers(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    proj = (await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]
    r = await client.patch(f"{API}/projects/{proj}", headers=headers, json={"readme": "plain string"})
    assert r.status_code == 200
    assert r.json()["readme"] == "plain string"
