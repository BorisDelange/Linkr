"""/projects/{uid}/client/*: the endpoints the R/Python client libraries call
from a kernel. They return database passwords, so they take a session or a
project-scoped kernel token, never a personal API key."""

from app.core.security import create_kernel_token, decode_token

API = "/api/v1"


async def _setup(client) -> tuple[dict, str, str]:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    token = (await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    uid = (await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]
    return headers, uid, token


async def test_session_and_kernel_tokens_are_accepted(client):
    headers, uid, token = await _setup(client)
    assert (await client.get(f"{API}/projects/{uid}/client/databases", headers=headers)).status_code == 200
    kernel = create_kernel_token(int(decode_token(token)["sub"]), "admin", "admin", uid, via="web")
    r = await client.get(f"{API}/projects/{uid}/client/databases", headers={"Authorization": f"Bearer {kernel}"})
    assert r.status_code == 200


async def test_a_kernel_token_is_scoped_to_its_project(client):
    headers, uid, token = await _setup(client)
    kernel = create_kernel_token(int(decode_token(token)["sub"]), "admin", "admin", "another-project", via="web")
    r = await client.get(f"{API}/projects/{uid}/client/databases", headers={"Authorization": f"Bearer {kernel}"})
    assert r.status_code == 403


async def test_an_api_key_is_refused(client):
    headers, uid, _ = await _setup(client)
    key = (await client.post(f"{API}/auth/api-tokens", headers=headers, json={"name": "mcp"})).json()["token"]
    r = await client.get(f"{API}/projects/{uid}/client/databases", headers={"Authorization": f"Bearer {key}"})
    assert r.status_code == 401


async def test_a_kernel_started_by_an_api_key_gets_no_recipe(client):
    # API key → /execute → the kernel's LINKR_TOKEN → decrypted password: the
    # key is refused here, so must be the kernel it started.
    headers, uid, token = await _setup(client)
    user_id = int(decode_token(token)["sub"])
    agent = create_kernel_token(user_id, "admin", "admin", uid, via="api_key")
    r = await client.get(f"{API}/projects/{uid}/client/databases", headers={"Authorization": f"Bearer {agent}"})
    assert r.status_code == 401


async def test_execute_stamps_the_callers_auth_kind_on_the_kernel_token(client):
    headers, uid, _ = await _setup(client)
    key = (await client.post(f"{API}/auth/api-tokens", headers=headers, json={"name": "mcp"})).json()["token"]
    code = "import os; print(os.environ['LINKR_TOKEN'])"
    for auth, via in ((headers, "web"), ({"Authorization": f"Bearer {key}"}, "api_key")):
        r = await client.post(f"{API}/execute", headers=auth, json={
            "language": "python", "projectUid": uid, "code": code, "sessionId": f"s-{via}",
        })
        kernel = r.json()["stdout"].strip()
        assert decode_token(kernel)["via"] == via
        status = (await client.get(
            f"{API}/projects/{uid}/client/databases", headers={"Authorization": f"Bearer {kernel}"}
        )).status_code
        assert status == (200 if via == "web" else 401)


async def test_only_the_projects_linked_databases_are_listed(client):
    """linkr_connect() reaches what the project declares, not every database of
    its workspace: a script relying on an unlinked one would break on export."""
    headers, uid, _ = await _setup(client)
    ws = (await client.get(f"{API}/projects/{uid}", headers=headers)).json()["workspaceId"]

    async def database(alias: str) -> str:
        body = {"alias": alias, "name": alias, "sourceType": "database", "workspaceId": ws,
                "connectionConfig": {"engine": "duckdb"}}
        r = await client.post(f"{API}/data-sources", headers=headers, json=body)
        assert r.status_code == 201, r.text
        return r.json()["id"]

    linked = await database("linked_db")
    await database("other_db")
    r = await client.patch(f"{API}/projects/{uid}", headers=headers, json={"linkedDataSourceIds": [linked]})
    assert r.status_code == 200, r.text

    rows = (await client.get(f"{API}/projects/{uid}/client/databases", headers=headers)).json()
    assert [row["alias"] for row in rows] == ["linked_db"]
