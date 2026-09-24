"""Freezing a cohort's membership server-side: POST /cohorts/{id}/materialize runs
the membership query whole and stores it; DELETE .../materialization drops it."""

from datetime import datetime, timezone

import duckdb

from app.services import cohort_service
from app.services.data import managed_db

API = "/api/v1"
MCP = {"X-Linkr-Client": "mcp"}
MAPPING = {"patientTable": {"table": "person", "idColumn": "person_id"}}
MEMBERSHIP = "SELECT DISTINCT person_id AS id, person_id AS patient_id FROM person WHERE person_id <= 5"


def test_build_materialization_matches_the_front_shape():
    mat = cohort_service.build_materialization(
        "visit", [10, 11, None, 12.0], [1, 1, 2, None],
        datetime(2026, 9, 24, 12, 0, 0, 123000, tzinfo=timezone.utc),
    )
    assert mat == {
        "level": "visit",
        "ids": ["10", "11", "12"],
        "patientIds": ["1", "2"],
        "count": 3,
        "materializedAt": "2026-09-24T12:00:00.123Z",
    }


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _setup(client, headers, rows: int = 20) -> tuple[str, str]:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    ds = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "src", "name": "src", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "managed": True}, "schemaMapping": MAPPING,
    })).json()["id"]
    r = await client.post(f"{API}/data-sources/{ds}/create-from-ddl", headers=headers,
                          json={"ddl": "CREATE TABLE person (person_id BIGINT);"})
    assert r.status_code == 200, r.text
    con = duckdb.connect(str(managed_db.path_for(ds)))
    con.execute(f"INSERT INTO person SELECT i FROM range(1, {rows + 1}) t(i)")
    con.close()
    proj = (await client.post(f"{API}/projects", headers=headers, json={
        "name": {"en": "P"}, "workspaceId": ws,
    })).json()["uid"]
    return proj, ds


async def _cohort(client, headers, **fields) -> str:
    r = await client.post(f"{API}/cohorts", headers=headers, json={
        "id": "c1", "name": {"en": "Five"}, "level": "patient", "criteriaTree": {}, **fields,
    })
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_materialize_stores_the_whole_membership_and_notifies(client):
    headers = await _admin(client)
    proj, ds = await _setup(client, headers)
    cid = await _cohort(client, headers, projectUid=proj, dataSourceId=ds)

    r = await client.post(f"{API}/cohorts/{cid}/materialize", headers={**headers, **MCP},
                          json={"membershipSql": MEMBERSHIP})
    assert r.status_code == 200, r.text
    body = r.json()
    mat = body["materialization"]
    assert sorted(mat["ids"], key=int) == ["1", "2", "3", "4", "5"]
    assert sorted(mat["patientIds"], key=int) == ["1", "2", "3", "4", "5"]
    assert mat["count"] == 5 and mat["level"] == "patient" and mat["materializedAt"].endswith("Z")
    assert body["resultCount"] == 5

    notes = (await client.get(f"{API}/notifications", headers=headers)).json()
    frozen = next(n for n in notes if n["entityId"] == cid and n["action"] == "updated")
    assert frozen["detail"] == {"part": "materialization", "action": "created", "name": {"en": ""}, "count": 5}
    assert frozen["undoable"]

    r = await client.delete(f"{API}/cohorts/{cid}/materialization", headers={**headers, **MCP})
    assert r.status_code == 200 and r.json()["materialization"] is None
    notes = (await client.get(f"{API}/notifications", headers=headers)).json()
    assert notes[0]["detail"]["part"] == "materialization" and notes[0]["detail"]["action"] == "deleted"


async def test_materialize_is_not_capped_at_the_query_row_limit(client):
    headers = await _admin(client)
    proj, ds = await _setup(client, headers, rows=12_000)
    cid = await _cohort(client, headers, projectUid=proj, dataSourceId=ds)
    r = await client.post(f"{API}/cohorts/{cid}/materialize", headers=headers, json={
        "membershipSql": "SELECT person_id AS id, person_id AS patient_id FROM person",
    })
    assert r.status_code == 200, r.text
    assert r.json()["materialization"]["count"] == 12_000


async def test_materialize_refusals(client):
    headers = await _admin(client)
    proj, ds = await _setup(client, headers)

    no_db = await _cohort(client, headers, projectUid=proj)
    r = await client.post(f"{API}/cohorts/{no_db}/materialize", headers=headers, json={"membershipSql": MEMBERSHIP})
    assert r.status_code == 400
    # An explicit database is used when the cohort names none.
    r = await client.post(f"{API}/cohorts/{no_db}/materialize", headers=headers,
                          json={"membershipSql": MEMBERSHIP, "dataSourceId": ds})
    assert r.status_code == 200 and r.json()["materialization"]["count"] == 5

    r = await client.post(f"{API}/cohorts/{no_db}/materialize", headers=headers,
                          json={"membershipSql": "SELECT 1 AS x", "dataSourceId": ds})
    assert r.status_code == 422

    await client.patch(f"{API}/cohorts/{no_db}", headers=headers, json={"level": "event"})
    r = await client.post(f"{API}/cohorts/{no_db}/materialize", headers=headers,
                          json={"membershipSql": MEMBERSHIP, "dataSourceId": ds})
    assert r.status_code == 400

    r = await client.post(f"{API}/cohorts", headers=headers, json={
        "id": "db1", "ownerDataSourceId": ds, "name": {"en": "Own"}, "level": "patient", "criteriaTree": {},
    })
    r = await client.post(f"{API}/cohorts/db1/materialize", headers=headers, json={"membershipSql": MEMBERSHIP})
    assert r.status_code == 400
