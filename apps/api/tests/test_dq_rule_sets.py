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


async def _workspace(client, headers) -> str:
    return (
        await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})
    ).json()["id"]


async def _rule_set(client, headers, ws: str, rid="r1") -> dict:
    return (await client.post(f"{API}/dq-rule-sets", headers=headers, json={
        "id": rid, "workspaceId": ws, "name": {"en": "Quality"}, "description": {},
        "dataSourceId": "src-1",
    })).json()


async def test_rule_set_crud(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    r = await _rule_set(client, headers, ws)
    assert r["workspaceId"] == ws and r["status"] == "draft"

    listed = (await client.get(f"{API}/dq-rule-sets?workspaceId={ws}", headers=headers)).json()
    assert [x["id"] for x in listed] == [r["id"]]

    p = await client.patch(f"{API}/dq-rule-sets/{r['id']}", headers=headers,
                           json={"status": "success", "lastScore": 87.5})
    assert p.json()["status"] == "success" and p.json()["lastScore"] == 87.5

    assert (await client.delete(f"{API}/dq-rule-sets/{r['id']}", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/dq-rule-sets/{r['id']}", headers=headers)).status_code == 404


async def test_list_all_without_workspace_filter(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    await _rule_set(client, headers, ws)
    resp = await client.get(f"{API}/dq-rule-sets", headers=headers)
    assert resp.status_code == 200 and len(resp.json()) == 1


async def test_check_crud_and_cascade(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    r = await _rule_set(client, headers, ws)

    check = (await client.post(f"{API}/dq-custom-checks", headers=headers, json={
        "id": "chk1", "ruleSetId": r["id"], "name": "no null person_id",
        "description": "", "category": "completeness", "severity": "error",
        "threshold": 0.95, "sql": "SELECT 1", "order": 0,
    })).json()
    assert check["ruleSetId"] == r["id"] and check["threshold"] == 0.95
    assert check["category"] == "completeness"

    checks = (await client.get(f"{API}/dq-rule-sets/{r['id']}/checks", headers=headers)).json()
    assert [c["id"] for c in checks] == ["chk1"]

    p = await client.patch(f"{API}/dq-custom-checks/{check['id']}", headers=headers,
                           json={"sql": "SELECT 2"})
    assert p.json()["sql"] == "SELECT 2"

    # Deleting the rule set cascades to its checks.
    assert (await client.delete(f"{API}/dq-rule-sets/{r['id']}", headers=headers)).status_code == 204
    r2 = await _rule_set(client, headers, ws, rid="r2")
    assert (await client.get(f"{API}/dq-rule-sets/{r2['id']}/checks", headers=headers)).json() == []


async def test_delete_checks_for_rule_set(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    r = await _rule_set(client, headers, ws)
    await client.post(f"{API}/dq-custom-checks", headers=headers, json={
        "id": "chk1", "ruleSetId": r["id"], "name": "c", "description": "",
        "category": "validity", "severity": "warning", "threshold": 1, "sql": "SELECT 1", "order": 0,
    })
    assert (await client.delete(f"{API}/dq-rule-sets/{r['id']}/checks", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/dq-rule-sets/{r['id']}/checks", headers=headers)).json() == []


async def test_non_member_cannot_access(client, db):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    r = await _rule_set(client, admin, ws)
    other = await _create_user(db, client, "bob")
    assert (await client.get(f"{API}/dq-rule-sets?workspaceId={ws}", headers=other)).status_code == 403
    assert (await client.delete(f"{API}/dq-rule-sets/{r['id']}", headers=other)).status_code == 403
