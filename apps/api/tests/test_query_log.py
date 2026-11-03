"""Every query sent to a database is a job of its workspace (kind "sql_query"):
its SQL, its origin, its row count — never its rows — kept `query_log_hours`."""

import asyncio
from datetime import UTC, datetime, timedelta

import duckdb
from sqlalchemy import update

from app.config import settings
from app.models.job import Job
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
        "workspaceId": ws, "alias": "d", "name": "d", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "managed": True},
    })).json()["id"]
    r = await client.post(f"{API}/data-sources/{ds}/create-from-ddl", headers=headers, json={"ddl": "CREATE TABLE t (a INT);"})
    assert r.status_code == 200, r.text
    con = duckdb.connect(str(managed_db.path_for(ds)))
    con.execute("INSERT INTO t SELECT i FROM range(3) r(i)")
    con.close()
    return ws, ds


async def _log(client, headers, ws) -> list[dict]:
    # The end of a query job is written by a task of its own.
    await asyncio.gather(*list(jobs._status_writes), return_exceptions=True)
    return (await client.get(f"{API}/workspaces/{ws}/query-log", headers=headers)).json()


async def test_a_query_is_a_job_with_its_sql_origin_and_row_count(client):
    headers = await _admin(client)
    ws, ds = await _database(client, headers)
    r = await client.post(f"{API}/data-sources/{ds}/query", headers=headers, json={"sql": "SELECT a FROM t", "origin": "Cohort · Sepsis"})
    assert r.status_code == 200 and len(r.json()["rows"]) == 3

    [job] = await _log(client, headers, ws)
    assert job["kind"] == "sql_query" and job["label"] == "Cohort · Sepsis" and job["status"] == "done"
    assert job["logTail"].startswith("3 rows") and job["startedAt"] and job["finishedAt"]
    full = (await client.get(f"{API}/jobs/{job['id']}?withInput=true", headers=headers)).json()
    assert full["input"].startswith("SELECT a FROM t")
    # Kept apart from the panel's jobs, which a page of queries would push out.
    assert (await client.get(f"{API}/workspaces/{ws}/jobs", headers=headers)).json() == []


async def test_a_failed_query_is_an_error_job(client):
    headers = await _admin(client)
    ws, ds = await _database(client, headers)
    r = await client.post(f"{API}/data-sources/{ds}/query", headers=headers, json={"sql": "SELECT nope FROM t"})
    assert r.status_code == 422
    [job] = await _log(client, headers, ws)
    assert job["status"] == "error" and job["label"] == "SQL query" and "nope" in job["logTail"]


async def test_queries_are_kept_their_retention_only(client, db, monkeypatch):
    headers = await _admin(client)
    ws, ds = await _database(client, headers)
    await client.post(f"{API}/data-sources/{ds}/query", headers=headers, json={"sql": "SELECT 1 AS x"})
    [old] = await _log(client, headers, ws)
    await db.execute(update(Job).where(Job.id == old["id"]).values(created_at=datetime.now(UTC) - timedelta(hours=25)))
    await db.commit()
    monkeypatch.setattr(jobs, "_last_purge", 0.0)
    await client.post(f"{API}/data-sources/{ds}/query", headers=headers, json={"sql": "SELECT 2 AS x"})
    assert [j["id"] for j in await _log(client, headers, ws)] != [old["id"]]
    assert len(await _log(client, headers, ws)) == 1

    monkeypatch.setattr(settings, "query_log_hours", 0)
    await client.post(f"{API}/data-sources/{ds}/query", headers=headers, json={"sql": "SELECT 3 AS x"})
    assert len(await _log(client, headers, ws)) == 1


async def test_clearing_the_log_keeps_the_jobs(client):
    headers = await _admin(client)
    ws, ds = await _database(client, headers)
    await client.post(f"{API}/data-sources/{ds}/query", headers=headers, json={"sql": "SELECT 1 AS x"})
    await _log(client, headers, ws)
    assert (await client.delete(f"{API}/workspaces/{ws}/query-log", headers=headers)).status_code == 204
    assert await _log(client, headers, ws) == []
