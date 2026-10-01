from app.core.security import hash_password
from app.models.user import User

API = "/api/v1"


async def _admin_headers(client) -> dict:
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"}
    )
    r = await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"}
    )
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _create_user(db, client, username: str) -> dict:
    db.add(User(username=username, password_hash=hash_password("pw-for-tests-only"), role="user"))
    await db.commit()
    r = await client.post(
        f"{API}/auth/login", json={"username": username, "password": "pw-for-tests-only"}
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


async def test_run_history_crud_and_report_roundtrip(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    rs = await _rule_set(client, headers, ws)

    # Create a run with a full report (so a past run can be reopened).
    report = {"computedAt": "2026-07-14T10:00:00Z", "checks": [{"id": "c1"}], "results": [{"checkId": "c1", "status": "pass"}], "summary": {"total": 1, "passed": 1}}
    created = (await client.post(f"{API}/dq-run-history", headers=headers, json={
        "id": "run-1", "ruleSetId": rs["id"], "dataSourceId": "src-1",
        "startedAt": "2026-07-14T10:00:00Z", "status": "success", "score": 100,
        "totalChecks": 1, "passed": 1, "failed": 0, "errors": 0, "notApplicable": 0,
        "report": report,
    })).json()
    assert created["id"] == "run-1"

    # Listed under the rule set, with the report preserved (reopen works after reload).
    runs = (await client.get(f"{API}/dq-rule-sets/{rs['id']}/runs", headers=headers)).json()
    assert len(runs) == 1
    assert runs[0]["report"]["summary"]["passed"] == 1

    # Delete a single run.
    assert (await client.delete(f"{API}/dq-run-history/run-1", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/dq-rule-sets/{rs['id']}/runs", headers=headers)).json() == []

    # Clear all runs for the rule set.
    await client.post(f"{API}/dq-run-history", headers=headers, json={
        "id": "run-2", "ruleSetId": rs["id"], "dataSourceId": "src-1",
        "startedAt": "2026-07-14T11:00:00Z", "status": "success",
        "totalChecks": 0, "passed": 0, "failed": 0, "errors": 0, "notApplicable": 0,
    })
    assert (await client.delete(f"{API}/dq-rule-sets/{rs['id']}/runs", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/dq-rule-sets/{rs['id']}/runs", headers=headers)).json() == []


async def test_create_run_requires_rule_set_and_membership(client, db):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    rs = await _rule_set(client, headers, ws)

    # A run without a ruleSetId is rejected at validation (no orphan-write path).
    assert (await client.post(f"{API}/dq-run-history", headers=headers, json={
        "id": "orphan", "dataSourceId": "src-1", "startedAt": "2026-07-14T10:00:00Z",
        "status": "success",
    })).status_code == 422

    # A non-member cannot write a run against someone else's rule set.
    other = await _create_user(db, client, "bob")
    resp = await client.post(f"{API}/dq-run-history", headers=other, json={
        "id": "run-x", "ruleSetId": rs["id"], "dataSourceId": "src-1",
        "startedAt": "2026-07-14T10:00:00Z", "status": "success",
    })
    assert resp.status_code == 403

    # The server stamps workspaceId from the rule set, ignoring a spoofed client value.
    created = (await client.post(f"{API}/dq-run-history", headers=headers, json={
        "id": "run-ws", "ruleSetId": rs["id"], "workspaceId": "spoofed",
        "dataSourceId": "src-1", "startedAt": "2026-07-14T10:00:00Z", "status": "success",
    })).json()
    assert created["workspaceId"] == ws



async def test_create_checks_in_one_request(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    rs_id = (await _rule_set(client, headers, ws))["id"]
    checks = [
        {
            "id": f"c{i}", "ruleSetId": rs_id, "name": f"check {i}", "category": "conformance",
            "subcategory": "relational", "severity": "error",
            "sql": "SELECT 0 AS violated_rows, 1 AS total_rows",
            "order": i, "origin": "ddl", "templateKey": f"ddl.not_null:t.c{i}", "tableName": "t",
        }
        for i in range(3)
    ]
    r = await client.post(f"{API}/dq-rule-sets/{rs_id}/checks", headers=headers, json=checks)
    assert r.status_code == 201, r.text
    body = r.json()
    assert [c["id"] for c in body] == ["c0", "c1", "c2"]
    assert body[0]["origin"] == "ddl" and body[0]["disabled"] is False

    p = await client.patch(f"{API}/dq-custom-checks/c1", headers=headers, json={"disabled": True})
    assert p.json()["disabled"] is True

    # Moving a check to another group, then out of every group.
    p = await client.patch(f"{API}/dq-custom-checks/c1", headers=headers, json={"tableName": "renamed"})
    assert p.json()["tableName"] == "renamed"
    p = await client.patch(f"{API}/dq-custom-checks/c1", headers=headers, json={"tableName": None})
    assert p.json()["tableName"] is None
    p = await client.patch(
        f"{API}/dq-custom-checks/c2", headers=headers,
        json={"exploreSql": "SELECT 1", "subcategory": None, "category": "completeness"},
    )
    assert p.json()["exploreSql"] == "SELECT 1" and p.json()["subcategory"] is None

    stray = [{**checks[0], "id": "x", "ruleSetId": "other"}]
    r = await client.post(f"{API}/dq-rule-sets/{rs_id}/checks", headers=headers, json=stray)
    assert r.status_code == 400


def _check(rid: str, cid: str = "c1", **over) -> dict:
    return {"id": cid, "ruleSetId": rid, "name": "N", "category": "plausibility",
            "subcategory": "temporal", "severity": "warning", "threshold": 0, "sql": "SELECT 1", **over}


async def test_checks_follow_the_taxonomy(client):
    headers = await _admin_headers(client)
    r = await _rule_set(client, headers, await _workspace(client, headers))

    def post(**over):
        return client.post(f"{API}/dq-custom-checks", headers=headers, json=_check(r["id"], **over))

    assert (await post(category="accuracy")).status_code == 422
    assert (await post(subcategory="value")).status_code == 422  # a conformance subcategory
    assert (await post(severity="fatal")).status_code == 422
    assert (await post(threshold=150)).status_code == 422

    # What older exports carry is read into the Kahn taxonomy.
    legacy = (await post(cid="c2", category="validity", subcategory=None, severity="info")).json()
    assert (legacy["category"], legacy["subcategory"], legacy["severity"]) == ("conformance", "value", "notice")


async def test_check_update_refuses_null_and_refits_the_subcategory(client):
    headers = await _admin_headers(client)
    r = await _rule_set(client, headers, await _workspace(client, headers))
    c = (await client.post(f"{API}/dq-custom-checks", headers=headers, json=_check(r["id"]))).json()

    def patch(body):
        return client.patch(f"{API}/dq-custom-checks/{c['id']}", headers=headers, json=body)

    for field in ("category", "severity", "threshold", "sql", "disabled"):
        assert (await patch({field: None})).status_code == 422, field
    assert (await patch({"tableName": None})).status_code == 200  # nullable: "Other checks"

    moved = (await patch({"category": "conformance"})).json()
    assert (moved["category"], moved["subcategory"]) == ("conformance", "value")
    assert (await patch({"subcategory": "temporal"})).status_code == 422
    assert (await patch({"category": "completeness"})).json()["subcategory"] is None


async def test_rule_set_keeps_its_empty_check_groups(client):
    headers = await _admin_headers(client)
    r = await _rule_set(client, headers, await _workspace(client, headers))
    assert r["checkGroups"] is None
    p = await client.patch(f"{API}/dq-rule-sets/{r['id']}", headers=headers, json={"checkGroups": ["Vitals"]})
    assert p.json()["checkGroups"] == ["Vitals"]
    assert (await client.get(f"{API}/dq-rule-sets/{r['id']}", headers=headers)).json()["checkGroups"] == ["Vitals"]


async def test_create_checks_refuses_taken_and_duplicate_ids(client):
    headers = await _admin_headers(client)
    rs_id = (await _rule_set(client, headers, await _workspace(client, headers)))["id"]
    url = f"{API}/dq-rule-sets/{rs_id}/checks"

    twice = [_check(rs_id, "a"), _check(rs_id, "a")]
    r = await client.post(url, headers=headers, json=twice)
    assert r.status_code == 409 and "a" in r.json()["detail"]
    assert (await client.get(url, headers=headers)).json() == []

    assert (await client.post(url, headers=headers, json=[_check(rs_id, "a")])).status_code == 201
    r = await client.post(url, headers=headers, json=[_check(rs_id, "b"), _check(rs_id, "a")])
    assert r.status_code == 409
    assert [c["id"] for c in (await client.get(url, headers=headers)).json()] == ["a"]


async def test_batches_are_capped(client, monkeypatch):
    from app.services import dq_rule_set_service

    monkeypatch.setattr(dq_rule_set_service, "MAX_CHECKS_PER_REQUEST", 2)
    headers = await _admin_headers(client)
    rs_id = (await _rule_set(client, headers, await _workspace(client, headers)))["id"]
    url = f"{API}/dq-rule-sets/{rs_id}/checks"
    body = [_check(rs_id, f"c{i}") for i in range(3)]
    assert (await client.post(url, headers=headers, json=body)).status_code == 413
    assert (await client.put(url, headers=headers, json=body)).status_code == 413
    patches = [{"id": f"c{i}", "disabled": True} for i in range(3)]
    assert (await client.patch(url, headers=headers, json=patches)).status_code == 413


async def test_replace_checks_is_all_or_nothing(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    rs_id = (await _rule_set(client, headers, ws))["id"]
    other = (await _rule_set(client, headers, ws, rid="r2"))["id"]
    url = f"{API}/dq-rule-sets/{rs_id}/checks"
    await client.post(url, headers=headers, json=[_check(rs_id, "old1"), _check(rs_id, "old2")])
    await client.post(f"{API}/dq-rule-sets/{other}/checks", headers=headers, json=[_check(other, "theirs")])

    def ids(listed):
        return sorted(c["id"] for c in listed)

    # Out of range, then an id another rule set holds: refused, nothing lost.
    assert (await client.put(url, headers=headers, json=[_check(rs_id, "n1", threshold=150)])).status_code == 422
    assert (await client.put(url, headers=headers, json=[_check(rs_id, "theirs")])).status_code == 409
    assert ids((await client.get(url, headers=headers)).json()) == ["old1", "old2"]

    # Its own ids may be reused by the new list.
    r = await client.put(url, headers=headers, json=[_check(rs_id, "old1"), _check(rs_id, "n2")])
    assert r.status_code == 200, r.text
    assert ids((await client.get(url, headers=headers)).json()) == ["n2", "old1"]
    assert ids((await client.get(f"{API}/dq-rule-sets/{other}/checks", headers=headers)).json()) == ["theirs"]


async def test_update_and_delete_checks_in_one_request(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    rs_id = (await _rule_set(client, headers, ws))["id"]
    other = (await _rule_set(client, headers, ws, rid="r2"))["id"]
    url = f"{API}/dq-rule-sets/{rs_id}/checks"
    await client.post(url, headers=headers, json=[_check(rs_id, f"c{i}", tableName="g") for i in range(3)])
    await client.post(f"{API}/dq-rule-sets/{other}/checks", headers=headers, json=[_check(other, "theirs")])

    r = await client.patch(url, headers=headers, json=[
        {"id": "c0", "tableName": "renamed"}, {"id": "c1", "tableName": "renamed"},
    ])
    assert r.status_code == 200, r.text
    assert {c["id"]: c["tableName"] for c in r.json()} == {"c0": "renamed", "c1": "renamed"}

    def groups(listed):
        return {c["id"]: c["tableName"] for c in listed}

    # One change that does not fit, or a check of another rule set: none applied.
    bad = [{"id": "c0", "tableName": "x"}, {"id": "c1", "category": "accuracy"}]
    assert (await client.patch(url, headers=headers, json=bad)).status_code == 422
    stray = [{"id": "c0", "tableName": "x"}, {"id": "theirs", "tableName": "x"}]
    assert (await client.patch(url, headers=headers, json=stray)).status_code == 404
    assert groups((await client.get(url, headers=headers)).json()) == {"c0": "renamed", "c1": "renamed", "c2": "g"}

    r = await client.post(f"{url}/batch-delete", headers=headers, json={"ids": ["c0", "c2", "theirs", "gone"]})
    assert r.status_code == 204
    assert list(groups((await client.get(url, headers=headers)).json())) == ["c1"]
    assert len((await client.get(f"{API}/dq-rule-sets/{other}/checks", headers=headers)).json()) == 1
