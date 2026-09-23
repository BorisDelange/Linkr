"""POST /data-sources/{id}/derive: permissions, targets, and what it records —
run as a job of the database's workspace."""

import contextlib

import duckdb

from app.core.security import hash_password
from app.models.user import User
from app.services.data import managed_db
from app.services.execution import jobs

API = "/api/v1"
MAPPING = {
    "presetId": "omop", "presetLabel": {"en": "OMOP"},
    "patientTable": {"table": "person", "idColumn": "person_id"},
    "visitTable": {"table": "visit_occurrence", "idColumn": "visit_occurrence_id", "patientIdColumn": "person_id", "startDateColumn": "d"},
}
DDL = (
    "CREATE TABLE person (person_id BIGINT);"
    "CREATE TABLE visit_occurrence (visit_occurrence_id BIGINT, person_id BIGINT, d DATE);"
    "CREATE TABLE concept (concept_id BIGINT);"
)


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _managed(client, headers, ws, alias, seed: bool) -> str:
    ds = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": alias, "name": alias, "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "managed": True}, "schemaMapping": MAPPING,
    })).json()["id"]
    if seed:
        r = await client.post(f"{API}/data-sources/{ds}/create-from-ddl", headers=headers, json={"ddl": DDL})
        assert r.status_code == 200, r.text
        con = duckdb.connect(str(managed_db.path_for(ds)))
        con.execute("INSERT INTO person SELECT i FROM range(1, 21) t(i)")
        con.execute("INSERT INTO visit_occurrence SELECT i, 1 + i % 20, DATE '2024-01-01' FROM range(1, 41) t(i)")
        con.execute("INSERT INTO concept SELECT i FROM range(5) t(i)")
        con.close()
    return ds


async def _derive(client, headers, ws, src, payload) -> dict:
    """Start a derivation and wait for its job; returns the finished job.

    Awaits the job's task rather than polling the API: the test database is one
    shared SQLite connection, and a request's session closing (a rollback) while
    the job's transaction is open on that same connection would undo the job's
    writes — a hazard of the fixture, not of the server."""
    r = await client.post(f"{API}/data-sources/{src}/derive", headers=headers, json=payload)
    assert r.status_code == 202, r.text
    job_id = r.json()["id"]
    assert r.json()["workspaceId"] == ws and r.json()["projectUid"] is None
    task = jobs._tasks.get(job_id)
    if task is not None:
        with contextlib.suppress(BaseException):
            await task
    rows = (await client.get(f"{API}/workspaces/{ws}/jobs", headers=headers)).json()
    return next(j for j in rows if j["id"] == job_id)


MEMBERSHIP = "SELECT DISTINCT person.person_id AS id, person.person_id AS patient_id FROM person WHERE person_id <= 5"


async def test_derive_into_a_new_database_and_record_it(client):
    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    src = await _managed(client, headers, ws, "src", seed=True)
    cohort = (await client.post(f"{API}/cohorts", headers=headers, json={
        "id": "c1", "ownerDataSourceId": src, "name": {"en": "Five"}, "level": "patient", "criteriaTree": {},
    })).json()["id"]
    dst = await _managed(client, headers, ws, "cohort_five", seed=False)

    job = await _derive(client, headers, ws, src, {
        "membershipSql": MEMBERSHIP, "level": "patient", "cohortId": cohort,
        "target": {"kind": "new-database", "dataSourceId": dst},
        "derivedFrom": {"database": {"label": "src"}, "cohort": {"key": "five"}},
    })
    assert job["status"] == "done" and job["kind"] == "derive" and job["progress"] == 100, job
    body = job["result"]
    assert body["patientCount"] == 5 and body["dataSourceId"] == dst and body["cohortId"] == cohort
    assert {t["table"]: t["rows"] for t in body["tables"]} == {"concept": 5, "person": 5, "visit_occurrence": 10}

    derived = (await client.get(f"{API}/data-sources/{dst}", headers=headers)).json()
    assert derived["derivedFrom"]["patientCount"] == 5 and derived["derivedFrom"]["cohort"] == {"key": "five"}
    assert derived["status"] == "connected" and derived["schemaMapping"]["patientTable"]["table"] == "person"
    rows = (await client.post(f"{API}/data-sources/{dst}/query", headers=headers, json={"sql": "SELECT COUNT(*) AS n FROM person"})).json()["rows"]
    assert rows == [{"n": 5}]

    recorded = (await client.get(f"{API}/cohorts/{cohort}", headers=headers)).json()["derivations"]
    assert [d["targetId"] for d in recorded] == [dst]

    # A rebuild writes the same file again, and still one derivation is recorded.
    job = await _derive(client, headers, ws, src, {
        "membershipSql": MEMBERSHIP.replace("<= 5", "<= 2"), "level": "patient", "cohortId": cohort,
        "target": {"kind": "new-database", "dataSourceId": dst},
    })
    assert job["status"] == "done" and job["result"]["patientCount"] == 2
    assert len((await client.get(f"{API}/cohorts/{cohort}", headers=headers)).json()["derivations"]) == 1


async def test_derive_into_a_schema_of_the_source_itself(client):
    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    src = await _managed(client, headers, ws, "src", seed=True)
    job = await _derive(client, headers, ws, src, {
        "membershipSql": MEMBERSHIP, "level": "patient",
        "target": {"kind": "schema", "dataSourceId": src, "schemaName": "cohort_1234"},
    })
    assert job["status"] == "done", job
    q = (await client.post(f"{API}/data-sources/{src}/query", headers=headers, json={"sql": "SELECT COUNT(*) AS n FROM cohort_1234.person"})).json()
    assert q.get("rows") == [{"n": 5}], q
    bad = await client.post(f"{API}/data-sources/{src}/derive", headers=headers, json={
        "membershipSql": MEMBERSHIP, "level": "patient",
        "target": {"kind": "schema", "dataSourceId": src, "schemaName": "Robert'); DROP"},
    })
    assert bad.status_code == 400


async def test_derive_needs_write_on_the_target(client, db):
    admin = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "WS"}})).json()["id"]
    src = await _managed(client, admin, ws, "src", seed=True)
    viewer = User(username="viewer", password_hash=hash_password("pw"), role="user")
    db.add(viewer)
    await db.commit()
    token = (await client.post(f"{API}/auth/login", json={"username": "viewer", "password": "pw"})).json()["access_token"]
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin, json={"userId": viewer.id, "role": "viewer"})
    r = await client.post(f"{API}/data-sources/{src}/derive", headers={"Authorization": f"Bearer {token}"}, json={
        "membershipSql": MEMBERSHIP, "level": "patient",
        "target": {"kind": "schema", "dataSourceId": src, "schemaName": "c"},
    })
    assert r.status_code == 403
    plan = await client.post(f"{API}/data-sources/{src}/derive-plan", headers={"Authorization": f"Bearer {token}"}, json={"level": "patient"})
    assert plan.status_code == 200 and {p["table"] for p in plan.json()} == {"person", "visit_occurrence", "concept"}


async def test_postgres_target_needs_its_write_toggle(client):
    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    src = await _managed(client, headers, ws, "src", seed=True)
    pg = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "pg", "name": "pg", "sourceType": "database",
        "connectionConfig": {"engine": "postgresql", "host": "localhost", "database": "x"},
    })).json()["id"]
    r = await client.post(f"{API}/data-sources/{src}/derive", headers=headers, json={
        "membershipSql": MEMBERSHIP, "level": "patient",
        "target": {"kind": "schema", "dataSourceId": pg, "schemaName": "cohort_x"},
    })
    assert r.status_code == 400 and "allow" in r.json()["detail"]


async def test_a_failed_first_build_removes_the_database_made_for_it(client):
    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    src = await _managed(client, headers, ws, "src", seed=True)
    dst = await _managed(client, headers, ws, "cohort_bad", seed=False)
    job = await _derive(client, headers, ws, src, {
        "membershipSql": "SELECT no_such_column AS id, 1 AS patient_id FROM person", "level": "patient",
        "target": {"kind": "new-database", "dataSourceId": dst},
    })
    assert job["status"] == "error" and job["logTail"], job
    assert "no_such_column" in job["logTail"]
    assert (await client.get(f"{API}/data-sources/{dst}", headers=headers)).status_code == 404
    # The panel's "clear all" keeps nothing finished.
    await client.delete(f"{API}/workspaces/{ws}/jobs", headers=headers)
    assert (await client.get(f"{API}/workspaces/{ws}/jobs", headers=headers)).json() == []
