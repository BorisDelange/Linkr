"""A frozen cohort's members belong to the database they were frozen on: moving
the cohort to another database unfreezes it, and a membership of another
database than the cohort's is never served as its own."""

import asyncio

import duckdb
from sqlalchemy import select

from app.config import settings
from app.models.cohort import Cohort
from app.models.notification import Notification
from app.services.data import managed_db

API = "/api/v1"
MCP = {"X-Linkr-Client": "mcp"}
MEMBERSHIP = "SELECT DISTINCT person_id AS id, person_id AS patient_id FROM person WHERE person_id <= 5"


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _database(client, headers, ws: str, alias: str) -> str:
    ds = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": alias, "name": alias, "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "managed": True},
    })).json()["id"]
    r = await client.post(f"{API}/data-sources/{ds}/create-from-ddl", headers=headers,
                          json={"ddl": "CREATE TABLE person (person_id BIGINT);"})
    assert r.status_code == 200, r.text
    con = duckdb.connect(str(managed_db.path_for(ds)))
    con.execute("INSERT INTO person SELECT i FROM range(1, 21) t(i)")
    con.close()
    return ds


async def _frozen_cohort(client, headers) -> tuple[str, str, str]:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    first, second = await _database(client, headers, ws, "first"), await _database(client, headers, ws, "second")
    proj = (await client.post(f"{API}/projects", headers=headers, json={
        "name": {"en": "P"}, "workspaceId": ws, "linkedDataSourceIds": [first, second],
    })).json()["uid"]
    r = await client.post(f"{API}/cohorts", headers=headers, json={
        "id": "c1", "projectUid": proj, "dataSourceId": first, "name": {"en": "Five"}, "level": "patient",
        "criteriaTree": {}, "attrition": [{"nodeId": "n", "label": "all", "count": 5}],
    })
    assert r.status_code == 201, r.text
    r = await client.post(f"{API}/cohorts/c1/materialize", headers=headers, json={"membershipSql": MEMBERSHIP})
    assert r.status_code == 200, r.text
    assert r.json()["materialization"]["dataSourceId"] == first
    return "c1", first, second


async def test_moving_a_frozen_cohort_to_another_database_unfreezes_it(client, db):
    headers = await _admin(client)
    cid, _, second = await _frozen_cohort(client, headers)

    r = await client.patch(f"{API}/cohorts/{cid}", headers={**headers, **MCP}, json={"dataSourceId": second})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dataSourceId"] == second
    assert body["materialization"] is None and body["resultCount"] is None and body["attrition"] is None

    details = (await db.execute(select(Notification.detail).where(Notification.entity_id == cid))).scalars().all()
    assert {"part": "materialization", "action": "deleted", "name": {"en": ""}} in details


async def test_editing_anything_else_keeps_it_frozen(client):
    headers = await _admin(client)
    cid, first, _ = await _frozen_cohort(client, headers)

    for change in ({"name": {"en": "Renamed"}}, {"dataSourceId": first}):
        r = await client.patch(f"{API}/cohorts/{cid}", headers=headers, json=change)
        assert r.status_code == 200, r.text
        assert r.json()["materialization"]["count"] == 5 and r.json()["resultCount"] == 5


async def test_a_membership_of_another_database_is_not_served(client, db):
    headers = await _admin(client)
    cid, _, second = await _frozen_cohort(client, headers)

    cohort = (await db.execute(select(Cohort).where(Cohort.id == cid))).scalar_one()
    cohort.materialization = {**cohort.materialization, "dataSourceId": second}
    await db.commit()
    assert (await client.get(f"{API}/cohorts/{cid}", headers=headers)).json()["materialization"] is None
    project_cohorts = (await client.get(f"{API}/cohorts?projectUid={cohort.project_uid}", headers=headers)).json()
    assert project_cohorts[0]["materialization"] is None

    # One frozen before the database was recorded still reads as the cohort's.
    cohort.materialization = {k: v for k, v in cohort.materialization.items() if k != "dataSourceId"}
    await db.commit()
    assert (await client.get(f"{API}/cohorts/{cid}", headers=headers)).json()["materialization"]["count"] == 5


async def test_a_cohort_is_frozen_on_its_own_database_only(client):
    headers = await _admin(client)
    cid, _, second = await _frozen_cohort(client, headers)
    r = await client.post(f"{API}/cohorts/{cid}/materialize", headers=headers,
                          json={"membershipSql": MEMBERSHIP, "dataSourceId": second})
    assert r.status_code == 400


async def test_a_freeze_past_the_time_limit_is_stopped(client, monkeypatch):
    monkeypatch.setattr(settings, "query_timeout_seconds", 1)
    headers = await _admin(client)
    cid, _, _ = await _frozen_cohort(client, headers)
    endless = "SELECT count(*) AS id, 1 AS patient_id FROM range(100000000000) t(i)"
    r = await asyncio.wait_for(client.post(f"{API}/cohorts/{cid}/materialize", headers=headers,
                                           json={"membershipSql": endless}), 30)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "query_time_limit"
    r = await asyncio.wait_for(client.post(f"{API}/cohorts/{cid}/materialize", headers=headers,
                                           json={"membershipSql": MEMBERSHIP}), 30)
    assert r.status_code == 200
