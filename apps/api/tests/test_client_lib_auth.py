"""/projects/{uid}/client/*: the endpoints the R/Python client libraries call
from a kernel. They return database passwords, so they take a session or a
project-scoped kernel token, never a personal API key."""

from app.core.security import create_kernel_token, decode_token

API = "/api/v1"


async def _setup(client) -> tuple[dict, str, str]:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    token = (await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    uid = (await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]
    return headers, uid, token


async def test_session_and_kernel_tokens_are_accepted(client):
    headers, uid, token = await _setup(client)
    assert (await client.get(f"{API}/projects/{uid}/client/databases", headers=headers)).status_code == 200
    kernel = create_kernel_token(int(decode_token(token)["sub"]), "admin", "admin", uid)
    r = await client.get(f"{API}/projects/{uid}/client/databases", headers={"Authorization": f"Bearer {kernel}"})
    assert r.status_code == 200


async def test_a_kernel_token_is_scoped_to_its_project(client):
    headers, uid, token = await _setup(client)
    kernel = create_kernel_token(int(decode_token(token)["sub"]), "admin", "admin", "another-project")
    r = await client.get(f"{API}/projects/{uid}/client/databases", headers={"Authorization": f"Bearer {kernel}"})
    assert r.status_code == 403


async def test_an_api_key_is_refused(client):
    headers, uid, _ = await _setup(client)
    key = (await client.post(f"{API}/auth/api-tokens", headers=headers, json={"name": "mcp"})).json()["token"]
    r = await client.get(f"{API}/projects/{uid}/client/databases", headers={"Authorization": f"Bearer {key}"})
    assert r.status_code == 401
