"""A project moving to another workspace leaves behind what it derived from the
databases it leaves: its destination holds no frozen membership, count or
attrition of a database of its former workspace."""

from tests.test_database_binding import _database, _member, _workspace
from tests.test_ide_files import _admin_headers

API = "/api/v1"
FROZEN = {"level": "patient", "ids": ["1", "2"], "patientIds": ["1", "2"], "count": 2,
          "materializedAt": "2026-01-01T00:00:00.000Z"}


async def _cohort(client, admin, uid: str, cohort_id: str, source_id: str | None) -> None:
    r = await client.post(f"{API}/cohorts", headers=admin, json={
        "id": cohort_id, "projectUid": uid, "name": {"en": cohort_id}, "level": "patient",
        "dataSourceId": source_id, "dataSourceRef": {"entityId": "x"} if source_id else None,
        "resultCount": 2, "attrition": [{"count": 2}], "materialization": FROZEN,
    })
    assert r.status_code == 201, r.text


async def test_a_moved_project_carries_no_result_of_the_databases_it_leaves(client, db, seed_roles):
    admin = await _admin_headers(client)
    ws_a, ws_b = await _workspace(client, admin, "A"), await _workspace(client, admin, "B")
    source = await _database(client, admin, ws_a, "local")
    viewer_b = await _member(client, db, ws_b, "viewer-b", "viewer")
    uid = (await client.post(f"{API}/projects", headers=admin, json={
        "name": {"en": "P"}, "workspaceId": ws_a, "linkedDataSourceIds": [source],
    })).json()["uid"]
    await _cohort(client, admin, uid, "bound", source)
    await _cohort(client, admin, uid, "fallback", None)
    assert (await client.get(f"{API}/cohorts/bound", headers=viewer_b)).status_code == 403

    moved = await client.patch(f"{API}/projects/{uid}", headers=admin, json={"workspaceId": ws_b})
    assert moved.status_code == 200, moved.text

    for cohort_id in ("bound", "fallback"):
        r = await client.get(f"{API}/cohorts/{cohort_id}", headers=viewer_b)
        assert r.status_code == 200, r.text
        cohort = r.json()
        assert cohort["materialization"] is None
        assert cohort["resultCount"] is None
        assert cohort["attrition"] is None
        assert cohort["dataSourceId"] is None
        assert cohort["dataSourceRef"] is None
    listed = (await client.get(f"{API}/cohorts?projectUid={uid}", headers=viewer_b)).json()
    assert all(c["materialization"] is None for c in listed)


async def test_a_project_staying_in_its_workspace_keeps_its_frozen_cohorts(client, db, seed_roles):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin, "A")
    source = await _database(client, admin, ws, "local")
    uid = (await client.post(f"{API}/projects", headers=admin, json={
        "name": {"en": "P"}, "workspaceId": ws, "linkedDataSourceIds": [source],
    })).json()["uid"]
    await _cohort(client, admin, uid, "kept", source)

    r = await client.patch(f"{API}/projects/{uid}", headers=admin, json={"workspaceId": ws, "readme": "x"})
    assert r.status_code == 200, r.text
    cohort = (await client.get(f"{API}/cohorts/kept", headers=admin)).json()
    assert cohort["materialization"] == FROZEN
    assert cohort["dataSourceId"] == source
