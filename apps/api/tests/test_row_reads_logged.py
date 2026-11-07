"""A frozen cohort's member ids and a method's score file reach the access log
whenever they are read, as every row-level read and download must."""

from app.core import audit

API = "/api/v1"


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    token = (await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def _count() -> int:
    return audit.query()[1]


async def test_reading_a_frozen_cohorts_members_is_logged(client):
    h = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=h, json={"name": {"en": "W"}})).json()["id"]
    uid = (await client.post(f"{API}/projects", headers=h, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]
    await client.post(f"{API}/cohorts", headers=h, json={
        "id": "c1", "projectUid": uid, "name": "Adults", "level": "patient",
        "criteriaTree": {"type": "group", "op": "and", "children": []},
    })
    await client.post(f"{API}/cohorts", headers=h, json={
        "id": "c2", "projectUid": uid, "name": "Open", "level": "patient",
        "criteriaTree": {"type": "group", "op": "and", "children": []},
    })
    await client.patch(f"{API}/cohorts/c1", headers=h, json={"materialization": {
        "level": "patient", "ids": ["901", "902"], "patientIds": ["901", "902"], "count": 2,
    }})

    for path in ("/cohorts/c1", f"/cohorts?projectUid={uid}", "/cohorts"):
        before = _count()
        assert (await client.get(f"{API}{path}", headers=h)).status_code == 200
        rows, total = audit.query()
        assert total == before + 1, path
        assert rows[0]["action"] == "preview" and rows[0]["project_uid"] == uid and rows[0]["row_count"] == 2

    before = _count()
    assert (await client.get(f"{API}/cohorts/c2", headers=h)).status_code == 200
    assert _count() == before


async def test_downloading_one_methods_scores_is_logged(client, monkeypatch):
    from app.services import scores_export

    h = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=h, json={"name": {"en": "W"}})).json()["id"]
    await client.post(f"{API}/mapping-projects", headers=h, json={
        "id": "mp1", "workspaceId": ws, "name": {"en": "M"}, "description": {},
        "sourceType": "database", "dataSourceId": "src-1", "conceptSetIds": [],
    })

    async def one_method(project, fmt, methods):
        return {f"similarity-scores/{methods[0]}.csv": b"source_concept_code,concept_id,score\nA,1,0.9\n"}

    monkeypatch.setattr(scores_export, "score_files", one_method)
    before = _count()
    r = await client.get(f"{API}/mapping-projects/mp1/scores/method-csv", headers=h, params={"method": "m1"})
    assert r.status_code == 200
    rows, total = audit.query()
    assert total == before + 1
    assert rows[0]["action"] == "download" and rows[0]["workspace_id"] == ws and "m1" in rows[0]["detail"]
