"""POST /data-sources/{id}/etl-jobs: an ETL script run as a job on its target."""

import asyncio
import contextlib

import duckdb

from app.services.data import managed_db
from app.services.data_source_service import _etl_runs
from app.services.execution import jobs

API = "/api/v1"


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _target(client, headers) -> tuple[str, str]:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "W"}})).json()["id"]
    ds = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "t", "name": "t", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "managed": True},
    })).json()["id"]
    r = await client.post(f"{API}/data-sources/{ds}/create-from-ddl", headers=headers, json={"ddl": "CREATE TABLE t (x BIGINT);"})
    assert r.status_code == 200, r.text
    return ws, ds


async def _start(client, headers, ds, sql) -> dict:
    r = await client.post(f"{API}/data-sources/{ds}/etl-jobs", headers=headers, json={"label": "ETL", "sql": sql})
    assert r.status_code == 202, r.text
    return r.json()


async def _settle(job_id: str) -> None:
    task = jobs._tasks.get(job_id)
    if task is not None:
        with contextlib.suppress(BaseException):
            await task


async def _job(client, headers, ws, job_id) -> dict:
    rows = (await client.get(f"{API}/workspaces/{ws}/jobs", headers=headers)).json()
    return next(j for j in rows if j["id"] == job_id)


async def test_a_script_runs_in_one_session_and_its_last_rows_are_served(client):
    headers = await _admin(client)
    ws, ds = await _target(client, headers)
    # A variable set by one statement is read by the next: one session.
    job = await _start(client, headers, ds, "SET VARIABLE n = 3; INSERT INTO target.t SELECT range FROM range(getvariable('n')); SELECT count(*) AS c FROM target.t;")
    assert job["kind"] == "etl"
    await _settle(job["id"])
    done = await _job(client, headers, ws, job["id"])
    assert done["status"] == "done", done["logTail"]
    assert done["result"]["total"] == 3 and done["result"]["index"] == 2
    rows = await client.get(f"{API}/data-sources/{ds}/query-jobs/{job['id']}/results/rows", headers=headers)
    assert rows.json() == {"rows": [{"c": 3}]}
    con = duckdb.connect(str(managed_db.path_for(ds)), read_only=True)
    assert con.execute("SELECT count(*) FROM t").fetchone() == (3,)
    con.close()


async def test_a_failing_statement_keeps_its_error(client):
    headers = await _admin(client)
    ws, ds = await _target(client, headers)
    job = await _start(client, headers, ds, "SELECT * FROM target.missing_table;")
    await _settle(job["id"])
    failed = await _job(client, headers, ws, job["id"])
    assert failed["status"] == "error" and "missing_table" in failed["result"]["error"]


async def test_cancel_interrupts_the_statement_and_frees_the_target(client):
    headers = await _admin(client)
    ws, ds = await _target(client, headers)
    job = await _start(client, headers, ds, "SELECT sum(a.i * b.i) FROM range(200000) a(i), range(200000) b(i);")
    for _ in range(250):
        if ds in _etl_runs:
            break
        await asyncio.sleep(0.02)
    assert (await client.post(f"{API}/jobs/{job['id']}/cancel", headers=headers)).status_code == 204
    await _settle(job["id"])
    assert (await _job(client, headers, ws, job["id"]))["status"] == "cancelled"
    assert ds not in _etl_runs
