"""Everything a database is asked is a job of its workspace (kind "sql_query"),
listed with the other jobs: its SQL, its purpose, its row count — never its
rows — and it can be stopped from the panel."""

import asyncio

import duckdb

from app.services.data import managed_db
from app.services.execution import jobs

API = "/api/v1"


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _database(client, headers) -> tuple[str, str]:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    ds = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "d", "name": {"en": "Demo"}, "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "managed": True},
    })).json()["id"]
    r = await client.post(f"{API}/data-sources/{ds}/create-from-ddl", headers=headers, json={"ddl": "CREATE TABLE t (a INT);"})
    assert r.status_code == 200, r.text
    con = duckdb.connect(str(managed_db.path_for(ds)))
    con.execute("INSERT INTO t SELECT i FROM range(3) r(i)")
    con.close()
    return ws, ds


async def _jobs(client, headers, ws) -> list[dict]:
    # The end of a job is written by a task of its own.
    await asyncio.gather(*list(jobs._status_writes), return_exceptions=True)
    return (await client.get(f"{API}/workspaces/{ws}/jobs", headers=headers)).json()


async def _queries(client, headers, ws) -> list[dict]:
    return [j for j in await _jobs(client, headers, ws) if j["kind"] == "sql_query"]


async def test_a_query_is_a_job_with_its_sql_purpose_and_row_count(client):
    headers = await _admin(client)
    ws, ds = await _database(client, headers)
    r = await client.post(f"{API}/data-sources/{ds}/query", headers=headers, json={"sql": "SELECT a FROM t", "origin": "Cohort · Sepsis"})
    assert r.status_code == 200 and len(r.json()["rows"]) == 3

    job = next(j for j in await _queries(client, headers, ws) if j["label"] == "Cohort · Sepsis")
    assert job["status"] == "done" and job["logTail"].startswith("3 rows") and job["startedAt"] and job["finishedAt"]
    full = (await client.get(f"{API}/jobs/{job['id']}?withInput=true", headers=headers)).json()
    assert full["input"].startswith("SELECT a FROM t")


async def test_the_queries_of_one_action_count_as_one_row_of_the_panel(client, monkeypatch):
    headers = await _admin(client)
    ws, ds = await _database(client, headers)
    group = {"groupKey": "patient:1", "groupLabel": "Patient 12"}
    for i in range(3):
        await client.post(f"{API}/data-sources/{ds}/query", headers=headers, json={"sql": "SELECT a FROM t", "origin": f"Widget {i}", **group})
    await client.post(f"{API}/data-sources/{ds}/query", headers=headers, json={"sql": "SELECT 1", "origin": "Alone"})

    grouped = [j for j in await _queries(client, headers, ws) if j["groupKey"] == "patient:1"]
    assert sorted(j["label"] for j in grouped) == ["Widget 0", "Widget 1", "Widget 2"]
    assert {j["groupLabel"] for j in grouped} == {"Patient 12"}

    # Three rows — the tables created, the group, the lone query — hold all five jobs.
    monkeypatch.setattr(jobs, "RECENT_JOBS", 3)
    assert len(await _queries(client, headers, ws)) == 5


async def test_a_failed_query_is_an_error_job(client):
    headers = await _admin(client)
    ws, ds = await _database(client, headers)
    r = await client.post(f"{API}/data-sources/{ds}/query", headers=headers, json={"sql": "SELECT nope FROM t"})
    assert r.status_code == 422
    [job] = [j for j in await _queries(client, headers, ws) if j["label"] == "SQL query"]
    assert job["status"] == "error" and "nope" in job["logTail"]


async def test_reading_the_tables_and_writing_them_are_jobs_too(client):
    headers = await _admin(client)
    ws, ds = await _database(client, headers)
    await client.get(f"{API}/data-sources/{ds}/schema", headers=headers)
    labels = {j["label"]: j for j in await _queries(client, headers, ws)}
    assert labels["Demo · create its tables (DDL)"]["status"] == "done"
    assert labels["Demo · list its tables and columns"]["logTail"] == "1 tables"


async def test_a_query_stopped_from_the_panel_answers_409(client):
    headers = await _admin(client)
    ws, ds = await _database(client, headers)
    slow = "SELECT count(*) AS n FROM range(100000000000) a"
    request = asyncio.create_task(client.post(f"{API}/data-sources/{ds}/query", headers=headers, json={"sql": slow, "origin": "slow"}))
    for _ in range(200):
        running = [j for j in await _queries(client, headers, ws) if j["label"] == "slow" and j["status"] == "running"]
        if running:
            break
        await asyncio.sleep(0.02)
    assert running
    assert (await client.post(f"{API}/jobs/{running[0]['id']}/cancel", headers=headers)).status_code == 204
    r = await asyncio.wait_for(request, 30)
    assert r.status_code == 409
    [job] = [j for j in await _queries(client, headers, ws) if j["label"] == "slow"]
    assert job["status"] == "cancelled"
