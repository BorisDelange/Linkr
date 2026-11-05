"""POST /data-sources/{id}/derive: permissions, targets, and what it records —
run as a job of the database's workspace."""

import contextlib

import duckdb
import pytest

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
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
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
    """Start a derivation and wait for its job; returns the finished job."""
    r = await client.post(f"{API}/data-sources/{src}/derive", headers=headers, json=payload)
    assert r.status_code == 202, r.text
    job_id = r.json()["id"]
    assert r.json()["workspaceId"] == ws and r.json()["projectUid"] is None
    task = jobs._tasks.get(job_id)
    if task is not None:
        with contextlib.suppress(BaseException):
            await task
    rows = (await client.get(f"{API}/workspaces/{ws}/jobs", headers=headers)).json()
    assert any(j["id"] == job_id for j in rows)
    return (await client.get(f"{API}/jobs/{job_id}", headers=headers)).json()


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

    # Once the database is deleted, the cohort no longer lists it.
    assert (await client.delete(f"{API}/data-sources/{dst}", headers=headers)).status_code == 204
    assert not (await client.get(f"{API}/cohorts/{cohort}", headers=headers)).json()["derivations"]


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
    viewer = User(username="viewer", password_hash=hash_password("pw-for-tests-only"), role="user")
    db.add(viewer)
    await db.commit()
    token = (await client.post(f"{API}/auth/login", json={"username": "viewer", "password": "pw-for-tests-only"})).json()["access_token"]
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


async def test_the_exported_trees_carry_the_provenance_not_the_instance_state(client, db):
    """What a derivation leaves in version control: the derived database's
    `derivedFrom` (so a clone knows its parent and can rebuild), never where its
    file sits on this machine nor whether it may be written; and the parent's
    cohort file without the record of what it was derived into."""
    import json

    from app.models.data_source import DataSource
    from app.services.workspace_export_assemble import build_database_tree

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
    assert job["status"] == "done", job

    target = await db.get(DataSource, dst)
    target.connection_config = {**target.connection_config, "managedPath": "/srv/data/five.duckdb", "allowWrites": True}
    await db.commit()
    await db.refresh(target)

    derived = json.loads((await build_database_tree(db, target))["entity.json"])
    assert derived["derivedFrom"]["cohort"] == {"key": "five"} and derived["derivedFrom"]["patientCount"] == 5
    assert derived["connectionConfig"] == {"engine": "duckdb", "managed": True}

    source = await db.get(DataSource, src)
    await db.refresh(source)
    parent = await build_database_tree(db, source)
    cohort_file = json.loads(parent["cohorts/five.json"])
    assert "derivations" not in cohort_file and "materialization" not in cohort_file


MCP = {"X-Linkr-Client": "mcp"}


async def test_an_agent_derivation_is_notified_and_its_job_readable_by_id(client, db):
    """An external client (the MCP) follows its job by id, and its user sees the
    database in the notification centre when the job starts and when it ends."""
    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    src = await _managed(client, headers, ws, "src", seed=True)
    cohort = (await client.post(f"{API}/cohorts", headers=headers, json={
        "id": "c1", "ownerDataSourceId": src, "name": {"en": "Five"}, "level": "patient", "criteriaTree": {},
    })).json()["id"]
    dst = await _managed(client, headers, ws, "cohort_five", seed=False)

    job = await _derive(client, {**headers, **MCP}, ws, src, {
        "membershipSql": MEMBERSHIP, "level": "patient", "cohortId": cohort,
        "target": {"kind": "new-database", "dataSourceId": dst},
    })
    assert job["status"] == "done", job
    by_id = (await client.get(f"{API}/jobs/{job['id']}", headers=headers)).json()
    assert by_id["status"] == "done" and by_id["result"]["dataSourceId"] == dst

    done, started = (await client.get(f"{API}/notifications", headers=headers)).json()[:2]
    assert started["entityType"] == "database" and started["entityId"] == dst and started["action"] == "created"
    assert started["detail"] == {"part": "derivation", "action": "started", "name": {"en": "Five"}, "workspaceId": ws}
    assert done["action"] == "updated" and done["detail"]["action"] == "done" and done["detail"]["count"] == 5
    assert done["label"] == {"en": "cohort_five"}

    # The app's own UI records nothing.
    await client.delete(f"{API}/notifications", headers=headers)
    await _derive(client, headers, ws, src, {
        "membershipSql": MEMBERSHIP, "level": "patient", "cohortId": cohort,
        "target": {"kind": "new-database", "dataSourceId": dst},
    })
    assert (await client.get(f"{API}/notifications", headers=headers)).json() == []

    # Someone else's job is not theirs to read.
    other = User(username="other", password_hash=hash_password("pw-for-tests-only"), role="user")
    db.add(other)
    await db.commit()
    token = (await client.post(f"{API}/auth/login", json={"username": "other", "password": "pw-for-tests-only"})).json()["access_token"]
    assert (await client.get(f"{API}/jobs/{job['id']}", headers={"Authorization": f"Bearer {token}"})).status_code == 404


async def test_a_failed_agent_derivation_notifies_the_removed_database(client):
    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    src = await _managed(client, headers, ws, "src", seed=True)
    dst = await _managed(client, headers, ws, "cohort_bad", seed=False)
    job = await _derive(client, {**headers, **MCP}, ws, src, {
        "membershipSql": "SELECT no_such_column AS id, 1 AS patient_id FROM person", "level": "patient",
        "target": {"kind": "new-database", "dataSourceId": dst},
        "derivedFrom": {"cohort": {"key": "bad", "name": {"en": "Bad"}}},
    })
    assert job["status"] == "error", job
    failed = (await client.get(f"{API}/notifications", headers=headers)).json()[0]
    assert failed["action"] == "deleted" and failed["entityId"] == dst
    assert failed["detail"]["action"] == "failed" and failed["detail"]["name"] == {"en": "Bad"}


async def _post_derive(client, headers, src, target) -> int:
    r = await client.post(f"{API}/data-sources/{src}/derive", headers=headers, json={
        "membershipSql": MEMBERSHIP, "level": "patient", "target": target,
    })
    return r.status_code


async def test_a_new_database_never_overwrites_data_it_did_not_derive(client):
    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    src = await _managed(client, headers, ws, "src", seed=True)
    other = await _managed(client, headers, ws, "other", seed=True)
    assert await _post_derive(client, headers, src, {"kind": "new-database", "dataSourceId": src}) == 400
    assert await _post_derive(client, headers, src, {"kind": "new-database", "dataSourceId": other}) == 400
    for ds in (src, other):
        rows = (await client.post(f"{API}/data-sources/{ds}/query", headers=headers, json={"sql": "SELECT COUNT(*) AS n FROM person"})).json()["rows"]
        assert rows == [{"n": 20}]


async def test_an_unreadable_target_file_is_refused_not_a_server_error(client):
    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    src = await _managed(client, headers, ws, "src", seed=True)
    dst = await _managed(client, headers, ws, "garbage", seed=False)
    garbage = managed_db.path_for(dst)
    garbage.parent.mkdir(parents=True, exist_ok=True)
    garbage.write_bytes(b"not a duckdb file" * 512)
    assert await _post_derive(client, headers, src, {"kind": "new-database", "dataSourceId": dst}) == 400


async def test_replace_only_drops_a_schema_a_derivation_created(client):
    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    src = await _managed(client, headers, ws, "src", seed=True)
    # The source's own schema, and a schema nobody derived, are never replaced.
    assert await _post_derive(client, headers, src, {"kind": "schema", "dataSourceId": src, "schemaName": "main"}) == 400
    assert await _post_derive(client, headers, src, {"kind": "schema", "dataSourceId": src, "schemaName": "cohort_a", "replace": True}) == 400

    job = await _derive(client, headers, ws, src, {
        "membershipSql": MEMBERSHIP, "level": "patient",
        "target": {"kind": "schema", "dataSourceId": src, "schemaName": "cohort_a"},
    })
    assert job["status"] == "done", job
    job = await _derive(client, headers, ws, src, {
        "membershipSql": MEMBERSHIP.replace("<= 5", "<= 2"), "level": "patient",
        "target": {"kind": "schema", "dataSourceId": src, "schemaName": "cohort_a", "replace": True},
    })
    assert job["status"] == "done", job
    q = (await client.post(f"{API}/data-sources/{src}/query", headers=headers, json={"sql": "SELECT COUNT(*) AS n FROM cohort_a.person"})).json()
    assert q["rows"] == [{"n": 2}]


async def test_a_client_cannot_write_a_cohort_s_derivations(client):
    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    src = await _managed(client, headers, ws, "src", seed=True)
    forged = [{"kind": "schema", "targetId": src, "schemaName": "main", "registeredId": src}]
    r = await client.post(f"{API}/cohorts", headers=headers, json={
        "id": "c1", "ownerDataSourceId": src, "name": {"en": "C"}, "level": "patient", "criteriaTree": {},
        "derivations": forged,
    })
    assert not r.json().get("derivations")
    r = await client.patch(f"{API}/cohorts/c1", headers=headers, json={"derivations": forged})
    assert not r.json().get("derivations")


def test_one_derivation_per_target_at_a_time():
    from app.services import cohort_derive_service as svc

    svc.reserve("t1")
    try:
        with pytest.raises(svc.DeriveBusy):
            svc.reserve("t1")
        svc.reserve("t2")
        svc.release("t2")
    finally:
        svc.release("t1")
    svc.reserve("t1")
    svc.release("t1")


async def test_a_derivation_drops_the_concept_caches_of_what_it_wrote(client):
    from app.services.data import concept_cache_fs

    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    src = await _managed(client, headers, ws, "src", seed=True)
    dst = await _managed(client, headers, ws, "cohort_five", seed=False)
    for ds in (src, dst):
        await client.put(f"{API}/data-sources/{ds}/concept-stats/1", headers=headers, json={"stats": {"rowCount": 1}})
        concept_cache_fs.write_manifest(ds, {"runId": "r1"}, reset=True)

    job = await _derive(client, headers, ws, src, {
        "membershipSql": MEMBERSHIP, "level": "patient", "target": {"kind": "new-database", "dataSourceId": dst},
    })
    assert job["status"] == "done", job
    assert (await client.get(f"{API}/data-sources/{dst}/concept-stats/1", headers=headers)).status_code == 404
    assert concept_cache_fs.run_status(dst) is None
    # The source it was read from is untouched.
    assert (await client.get(f"{API}/data-sources/{src}/concept-stats/1", headers=headers)).status_code == 200
    assert concept_cache_fs.run_status(src) is not None


async def _person_ids(client, headers, ds) -> set:
    rows = (await client.post(f"{API}/data-sources/{ds}/query", headers=headers, json={"sql": "SELECT person_id FROM person"})).json()["rows"]
    return {r["person_id"] for r in rows}


async def test_a_pseudonymised_build_keeps_its_key_sealed_and_a_rebuild_draws_the_same(client):
    from sqlalchemy import select

    from app.core.database import async_session
    from app.models.pseudonym_key import PseudonymKey

    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    src = await _managed(client, headers, ws, "src", seed=True)
    dst = await _managed(client, headers, ws, "cohort_p", seed=False)
    corr = await _managed(client, headers, ws, "corr", seed=True)
    payload = {
        "membershipSql": MEMBERSHIP, "level": "patient",
        "target": {"kind": "new-database", "dataSourceId": dst},
        "tables": [{"table": "person"}, {"table": "visit_occurrence"}],
        "pseudonymization": {"method": "hmac", "correspondence": {"dataSourceId": corr, "schemaName": "pseudo"}},
    }
    job = await _derive(client, headers, ws, src, payload)
    assert job["status"] == "done", job
    assert {t["table"]: t["skipped"] for t in job["result"]["tables"]}["concept"] is True
    first = await _person_ids(client, headers, dst)
    assert len(first) == 5 and not first & set(range(1, 21))
    derived = (await client.get(f"{API}/data-sources/{dst}", headers=headers)).json()
    assert derived["derivedFrom"]["derivationId"] == dst
    assert "key" not in str(derived["derivedFrom"]).lower()

    async with async_session() as db:
        row = (await db.execute(select(PseudonymKey).where(PseudonymKey.id == dst))).scalar_one()
        assert row.workspace_id == ws and row.sealed_key.startswith("v")

    rows = (await client.post(f"{API}/data-sources/{corr}/query", headers=headers, json={
        "sql": "SELECT original_id, pseudonym FROM pseudo.linkr_pseudonyms WHERE kind = 'patient'",
    })).json()["rows"]
    assert {r["pseudonym"] for r in rows} == first and {r["original_id"] for r in rows} == {"1", "2", "3", "4", "5"}

    job = await _derive(client, headers, ws, src, payload)
    assert job["status"] == "done" and await _person_ids(client, headers, dst) == first

    # Not kept: a new key, other pseudonyms, and no key left behind.
    job = await _derive(client, headers, ws, src, {**payload, "pseudonymization": {"method": "hmac", "keepKey": False}})
    assert job["status"] == "done" and not await _person_ids(client, headers, dst) & first
    async with async_session() as db:
        assert (await db.execute(select(PseudonymKey).where(PseudonymKey.id == dst))).scalar_one_or_none() is None


async def test_a_followed_cohort_reuses_the_key_of_another_derivation(client):
    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    src = await _managed(client, headers, ws, "src", seed=True)
    a = await _managed(client, headers, ws, "first", seed=False)
    b = await _managed(client, headers, ws, "second", seed=False)
    base = {"membershipSql": MEMBERSHIP, "level": "patient", "pseudonymization": {"method": "hmac"}}
    assert (await _derive(client, headers, ws, src, {**base, "target": {"kind": "new-database", "dataSourceId": a}}))["status"] == "done"
    job = await _derive(client, headers, ws, src, {
        **base, "target": {"kind": "new-database", "dataSourceId": b},
        "pseudonymization": {"method": "hmac", "reuseKeyOf": a},
    })
    assert job["status"] == "done"
    assert await _person_ids(client, headers, a) == await _person_ids(client, headers, b)


async def test_the_options_are_checked_before_any_job(client):
    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    src = await _managed(client, headers, ws, "src", seed=True)
    dst = await _managed(client, headers, ws, "cohort_x", seed=False)
    target = {"kind": "new-database", "dataSourceId": dst}

    async def status(**extra) -> int:
        r = await client.post(f"{API}/data-sources/{src}/derive", headers=headers, json={
            "membershipSql": MEMBERSHIP, "level": "visit", "target": target, **extra,
        })
        return r.status_code

    assert await status(scope="visit_detail") == 400
    assert await status(dates=[{"table": "person", "column": "d", "precision": "day"}]) == 400
    assert await status(pseudonymization={"method": "sha1"}) == 400
    assert await status(pseudonymization={"method": "hmac", "reuseKeyOf": "nope"}) == 400
    # The correspondence never goes into the derived database itself.
    assert await status(pseudonymization={"method": "random", "correspondence": {"dataSourceId": dst, "schemaName": "p"}}) == 400


async def test_the_correspondence_never_goes_into_the_derived_database_under_another_entry():
    from types import SimpleNamespace

    from app.schemas.data_source import DeriveRequest
    from app.services import cohort_derive_service

    server = {"engine": "postgresql", "host": "pg.internal", "port": 5432, "database": "cdm", "allowWrites": True}
    source = SimpleNamespace(id="src", workspace_id="ws", connection_config={"engine": "duckdb", "managed": True})
    target = SimpleNamespace(id="dst", workspace_id="ws", connection_config=server)
    second_entry = SimpleNamespace(id="dst-again", workspace_id="ws", connection_config=dict(server))

    class _Db:
        async def get(self, _model, key):
            return second_entry if key == "dst-again" else None

    body = DeriveRequest.model_validate({
        "membershipSql": MEMBERSHIP, "level": "visit",
        "target": {"kind": "schema", "dataSourceId": "dst", "schemaName": "cohort"},
        "pseudonymization": {"method": "random", "correspondence": {"dataSourceId": "dst-again", "schemaName": "pseudo"}},
    })
    with pytest.raises(cohort_derive_service.DeriveError, match="keep it apart"):
        await cohort_derive_service._correspondence_target(_Db(), source, target, body, 1)


async def _editor(client, db, admin, ws) -> dict:
    editor = User(username="editor", password_hash=hash_password("pw-for-tests-only"), role="user")
    db.add(editor)
    await db.commit()
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin, json={"userId": editor.id, "role": "editor"})
    token = (await client.post(f"{API}/auth/login", json={"username": "editor", "password": "pw-for-tests-only"})).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


FAILING = "SELECT no_such_column AS id, 1 AS patient_id FROM person"


@pytest.mark.parametrize("mark_managed", ["patch", "empty-ddl"])
async def test_a_failed_build_never_removes_a_database_the_launcher_may_not_delete(client, db, mark_managed):
    admin = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "WS"}})).json()["id"]
    src = await _managed(client, admin, ws, "src", seed=True)
    other = (await client.post(f"{API}/data-sources", headers=admin, json={
        "workspaceId": ws, "alias": "other", "name": "other", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb"},
    })).json()["id"]
    editor = await _editor(client, db, admin, ws)
    assert (await client.delete(f"{API}/data-sources/{other}", headers=editor)).status_code == 403
    if mark_managed == "patch":
        r = await client.patch(f"{API}/data-sources/{other}", headers=editor, json={"connectionConfig": {"engine": "duckdb", "managed": True}})
    else:
        r = await client.post(f"{API}/data-sources/{other}/create-from-ddl", headers=editor, json={"ddl": ""})
    assert r.status_code == 200, r.text
    job = await _derive(client, editor, ws, src, {
        "membershipSql": FAILING, "level": "patient", "target": {"kind": "new-database", "dataSourceId": other},
    })
    assert job["status"] == "error"
    assert (await client.get(f"{API}/data-sources/{other}", headers=admin)).status_code == 200


async def test_a_new_database_build_refuses_a_target_holding_cohorts(client, db):
    from app.models.cohort import Cohort

    admin = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "WS"}})).json()["id"]
    src = await _managed(client, admin, ws, "src", seed=True)
    dst = await _managed(client, admin, ws, "dst", seed=False)
    db.add(Cohort(id="coh-dst", owner_data_source_id=dst, name={"en": "c"}, level="patient"))
    await db.commit()
    assert await _post_derive(client, admin, src, {"kind": "new-database", "dataSourceId": dst}) == 400
    assert await db.get(Cohort, "coh-dst") is not None


async def test_a_failed_first_build_removes_the_editor_s_own_empty_card(client, db):
    admin = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "WS"}})).json()["id"]
    src = await _managed(client, admin, ws, "src", seed=True)
    editor = await _editor(client, db, admin, ws)
    dst = await _managed(client, editor, ws, "mine", seed=False)
    job = await _derive(client, editor, ws, src, {
        "membershipSql": FAILING, "level": "patient", "target": {"kind": "new-database", "dataSourceId": dst},
    })
    assert job["status"] == "error"
    assert (await client.get(f"{API}/data-sources/{dst}", headers=admin)).status_code == 404
