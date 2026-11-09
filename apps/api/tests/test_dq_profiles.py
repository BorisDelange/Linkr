from tests.test_dq_rule_sets import API, _admin_headers, _create_user, _rule_set, _workspace


async def _profile(client, headers, ws: str, pid="p1", **over) -> dict:
    r = await client.post(f"{API}/dq-profiles", headers=headers, json={
        "id": pid, "workspaceId": ws, "name": {"en": "ICU quality"}, "dataSourceId": "src-1",
        "sources": [{"ruleSetId": "r1", "mode": "all"}], **over,
    })
    assert r.status_code == 201, r.text
    return r.json()


async def test_profile_crud(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    p = await _profile(client, headers, ws)
    assert p["sources"] == [{"ruleSetId": "r1", "mode": "all"}] and p["status"] == "draft"

    listed = (await client.get(f"{API}/dq-profiles?workspaceId={ws}", headers=headers)).json()
    assert [x["id"] for x in listed] == ["p1"]

    sources = [{"ruleSetId": "r1", "mode": "selected", "checkKeys": ["a", "b"]}, {"ruleSetId": "r2", "mode": "all"}]
    patched = await client.patch(f"{API}/dq-profiles/p1", headers=headers, json={"sources": sources})
    assert patched.json()["sources"] == sources

    assert (await client.delete(f"{API}/dq-profiles/p1", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/dq-profiles/p1", headers=headers)).status_code == 404


async def test_profile_sources_are_checked(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    await _profile(client, headers, ws)
    for bad in (
        [{"ruleSetId": "r1", "mode": "some"}],
        [{"mode": "all"}],
        [{"ruleSetId": "r1", "mode": "all"}, {"ruleSetId": "r1", "mode": "all"}],
        [{"ruleSetId": "r1", "mode": "selected", "checkKeys": "a"}],
    ):
        r = await client.patch(f"{API}/dq-profiles/p1", headers=headers, json={"sources": bad})
        assert r.status_code == 422, bad
    r = await client.patch(f"{API}/dq-profiles/p1", headers=headers, json={"dataSourceId": None})
    assert r.status_code == 422


async def test_a_profile_is_reached_only_by_its_workspace_members(client, db):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    await _profile(client, admin, ws)
    other = await _create_user(db, client, "bob")
    assert (await client.get(f"{API}/dq-profiles?workspaceId={ws}", headers=other)).status_code == 403
    assert (await client.get(f"{API}/dq-profiles/p1", headers=other)).status_code == 403
    assert (await client.delete(f"{API}/dq-profiles/p1", headers=other)).status_code == 403
    assert (await client.get(f"{API}/dq-profiles", headers=other)).json() == []


async def test_profile_runs(client, db):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    await _profile(client, headers, ws)
    rs = await _rule_set(client, headers, ws)
    run = {"dataSourceId": "src-1", "startedAt": "2026-11-09T10:00:00Z", "status": "success"}

    created = await client.post(f"{API}/dq-run-history", headers=headers, json={
        "id": "run-1", "profileId": "p1", "workspaceId": "spoofed", **run,
    })
    assert created.status_code == 201, created.text
    assert created.json()["profileId"] == "p1" and created.json()["workspaceId"] == ws
    assert [r["id"] for r in (await client.get(f"{API}/dq-profiles/p1/runs", headers=headers)).json()] == ["run-1"]
    assert (await client.get(f"{API}/dq-rule-sets/{rs['id']}/runs", headers=headers)).json() == []

    # A run belongs to one owner, and its id never moves to another.
    both = {"id": "run-2", "profileId": "p1", "ruleSetId": rs["id"], **run}
    assert (await client.post(f"{API}/dq-run-history", headers=headers, json=both)).status_code == 422
    moved = {"id": "run-1", "ruleSetId": rs["id"], **run}
    assert (await client.post(f"{API}/dq-run-history", headers=headers, json=moved)).status_code == 409

    other = await _create_user(db, client, "bob")
    stray = {"id": "run-x", "profileId": "p1", **run}
    assert (await client.post(f"{API}/dq-run-history", headers=other, json=stray)).status_code == 403
    assert (await client.delete(f"{API}/dq-run-history/run-1", headers=other)).status_code == 403

    # Deleting the profile takes its runs along.
    await client.delete(f"{API}/dq-profiles/p1", headers=headers)
    assert (await client.delete(f"{API}/dq-run-history/run-1", headers=headers)).status_code == 404
