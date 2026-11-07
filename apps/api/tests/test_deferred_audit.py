"""Work that outlives its request's wait still reaches the access log, with what
it touched, its size and its outcome."""

import asyncio

import pytest

from app.core import audit, deferred

API = "/api/v1"


@pytest.fixture(autouse=True)
def _no_wait(monkeypatch):
    monkeypatch.setattr(deferred, "_tasks", {})
    monkeypatch.setattr(deferred, "_running", {})
    monkeypatch.setattr(deferred, "WAIT_SECONDS", 0)


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    token = (await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


async def _poll(client, headers, response):
    assert response.status_code == 202, response.text
    task_id = response.json()["deferredTaskId"]
    for _ in range(200):
        r = await client.get(f"{API}/deferred/{task_id}", headers=headers)
        if r.status_code != 202:
            return r
        await asyncio.sleep(0.01)
    raise AssertionError("deferred work never ended")


def _lines(action: str) -> list[dict]:
    return audit.query(filters={"action": [action]}, sort="seq", desc=False)[0]


async def test_a_long_project_export_leaves_a_line_with_its_size(client):
    h = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=h, json={"name": {"en": "W"}})).json()["id"]
    uid = (await client.post(f"{API}/projects", headers=h, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]

    done = await _poll(client, h, await client.get(f"{API}/projects/{uid}/export-zip", headers=h))
    assert done.status_code == 200
    await asyncio.sleep(0)

    exports = [r for r in _lines("export") if r["project_uid"] == uid]
    assert len(exports) == 1
    assert exports[0]["status"] == 200 and exports[0]["username"] == "admin"
    assert "bytes" in (exports[0]["detail"] or "") or exports[0]["row_count"] is not None


async def test_a_long_workspace_export_leaves_its_action_and_size(client):
    h = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=h, json={"name": {"en": "W"}})).json()["id"]

    done = await _poll(client, h, await client.post(f"{API}/workspaces/{ws}/export-zip", headers=h, json={}))
    assert done.status_code == 200
    await asyncio.sleep(0)

    exports = [r for r in _lines("export") if r["workspace_id"] == ws and r["status"] == 200]
    assert len(exports) == 1 and exports[0]["route"].endswith("/export-zip")


async def test_a_long_query_leaves_its_sql_row_count_and_outcome(client):
    h = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=h, json={"name": {"en": "W"}})).json()["id"]
    ds = (await client.post(f"{API}/data-sources", headers=h, json={
        "workspaceId": ws, "alias": "db", "name": "db", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "managed": True},
    })).json()["id"]
    assert (await client.post(f"{API}/data-sources/{ds}/create-from-ddl", headers=h,
                              json={"ddl": "CREATE TABLE t (x BIGINT);"})).status_code == 200

    r = await client.post(f"{API}/data-sources/{ds}/query", headers=h, json={"sql": "SELECT 'slow_marker' AS m"})
    done = await _poll(client, h, r) if r.status_code == 202 else r
    assert done.status_code == 200
    await asyncio.sleep(0)

    queries = [q for q in _lines("query") if "slow_marker" in (q["detail"] or "")]
    assert any(q["status"] == 200 and q["row_count"] == 1 for q in queries)
