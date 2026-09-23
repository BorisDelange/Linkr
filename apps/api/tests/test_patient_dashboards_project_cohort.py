"""A project cohort's patient board: that cohort's own, one per cohort, under the
project — listed with the project's boards (the client sets it apart from the
Patient data ones), gone with the cohort."""

API = "/api/v1"


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _project(client, headers) -> tuple[str, str]:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    uid = (await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]
    return ws, uid


async def _cohort(client, headers, uid: str, cid: str, data_source_id: str | None = "db-1") -> None:
    r = await client.post(f"{API}/cohorts", headers=headers, json={
        "id": cid, "projectUid": uid, "name": {"en": cid}, "level": "patient", "criteriaTree": {},
        "dataSourceId": data_source_id,
    })
    assert r.status_code == 201, r.text


async def _board(client, headers, uid: str, bid: str, cohort: str | None):
    return await client.post(f"{API}/patient-dashboards", headers=headers, json={
        "id": bid, "projectUid": uid, "ownerCohortId": cohort, "name": {"en": "Review"},
    })


async def test_one_board_per_project_cohort_reading_its_database(client):
    headers = await _admin(client)
    _, uid = await _project(client, headers)
    await _cohort(client, headers, uid, "c1")
    await _cohort(client, headers, uid, "c2")

    r = await _board(client, headers, uid, "b1", "c1")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["projectUid"] == uid and body["ownerCohortId"] == "c1"
    assert body["ownerDataSourceId"] is None and body["dataSourceId"] == "db-1"
    assert (await _board(client, headers, uid, "b2", "c1")).status_code == 409
    assert (await _board(client, headers, uid, "b2", "c2")).status_code == 201
    # A Patient data board beside them stays as it always was.
    assert (await _board(client, headers, uid, "b3", None)).status_code == 201

    listed = (await client.get(f"{API}/patient-dashboards?projectUid={uid}", headers=headers)).json()
    assert {b["id"]: b["ownerCohortId"] for b in listed} == {"b1": "c1", "b2": "c2", "b3": None}


async def test_the_cohort_must_be_one_of_the_projects(client):
    headers = await _admin(client)
    ws, uid = await _project(client, headers)
    other = (await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "Q"}, "workspaceId": ws})).json()["uid"]
    await _cohort(client, headers, other, "elsewhere")
    assert (await _board(client, headers, uid, "b1", "elsewhere")).status_code == 422
    assert (await _board(client, headers, uid, "b1", "missing")).status_code == 422
    # Still exactly one owner: a project board cannot also claim a database.
    r = await client.post(f"{API}/patient-dashboards", headers=headers, json={
        "id": "b2", "projectUid": uid, "ownerDataSourceId": "db-1", "name": {"en": "X"},
    })
    assert r.status_code == 422


async def test_board_goes_with_its_cohort(client):
    headers = await _admin(client)
    _, uid = await _project(client, headers)
    await _cohort(client, headers, uid, "c1")
    await _board(client, headers, uid, "b1", "c1")
    tab = await client.post(f"{API}/patient-dashboards/tabs", headers=headers, json={
        "id": "t1", "patientDashboardId": "b1", "name": {"en": "Tab"}, "displayOrder": 0,
    })
    assert tab.status_code == 201, tab.text

    await client.delete(f"{API}/cohorts/c1", headers=headers)
    assert (await client.get(f"{API}/patient-dashboards/b1", headers=headers)).status_code == 404
