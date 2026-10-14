"""POST /data-sources/{id}/query-jobs: queries run as a job, results fetched by key,
cancel interrupting the query in flight, one heavy query at a time."""

import asyncio
import contextlib

import duckdb
import pytest

from app.config import settings
from app.core import audit
from app.core.security import hash_password
from app.models.user import User
from app.services.data import managed_db, query_cancel, query_jobs
from app.services.execution import jobs

API = "/api/v1"
# Long enough to still be running when the test cancels it; DuckDB stops it at once.
SLOW = "SELECT sum(a.i * b.i) AS s FROM range(100000) a(i), range(100000) b(i)"


@pytest.fixture(autouse=True)
def _fresh_lanes(monkeypatch):
    # The lanes' semaphores bind to the loop of the test that first used them.
    monkeypatch.setattr(jobs, "_semaphores", {})


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _source(client, headers) -> tuple[str, str]:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "W"}})).json()["id"]
    ds = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "db", "name": "db", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "managed": True},
    })).json()["id"]
    r = await client.post(f"{API}/data-sources/{ds}/create-from-ddl", headers=headers, json={"ddl": "CREATE TABLE t (x BIGINT);"})
    assert r.status_code == 200, r.text
    con = duckdb.connect(str(managed_db.path_for(ds)))
    con.execute("INSERT INTO t SELECT i FROM range(10) t(i)")
    con.close()
    return ws, ds


async def _start(client, headers, ds, queries, label="Counts") -> dict:
    r = await client.post(f"{API}/data-sources/{ds}/query-jobs", headers=headers, json={
        "label": label, "queries": [{"key": k, "sql": q} for k, q in queries],
    })
    assert r.status_code == 202, r.text
    return r.json()


async def _settle(job_id: str) -> None:
    """Await the job's task (see test_cohort_derive_routes: polling the API while the
    job writes would race on the fixture's single SQLite connection)."""
    task = jobs._tasks.get(job_id)
    if task is not None:
        with contextlib.suppress(BaseException):
            await task


async def _job(client, headers, ws, job_id) -> dict:
    rows = (await client.get(f"{API}/workspaces/{ws}/jobs", headers=headers)).json()
    return next(j for j in rows if j["id"] == job_id)


async def _until_running(job_id: str, timeout: float = 5.0) -> None:
    async def wait():
        while f"job:{job_id}" not in query_cancel._running:
            await asyncio.sleep(0.02)
    await asyncio.wait_for(wait(), timeout)


async def test_runs_every_query_and_serves_each_result(client):
    headers = await _admin(client)
    ws, ds = await _source(client, headers)
    job = await _start(client, headers, ds, [("u0", "SELECT count(*) AS n FROM t"), ("u1", "SELECT x FROM t WHERE x < 3 ORDER BY x")])
    assert job["kind"] == "query" and job["workspaceId"] == ws
    await _settle(job["id"])

    done = await _job(client, headers, ws, job["id"])
    assert done["status"] == "done" and done["progress"] == 100
    assert done["result"]["done"] == ["u0", "u1"] and done["result"]["rows"] == {"u0": 1, "u1": 3}
    r0 = await client.get(f"{API}/data-sources/{ds}/query-jobs/{job['id']}/results/u0", headers=headers)
    assert r0.json() == {"rows": [{"n": 10}]}
    r1 = await client.get(f"{API}/data-sources/{ds}/query-jobs/{job['id']}/results/u1", headers=headers)
    assert [row["x"] for row in r1.json()["rows"]] == [0, 1, 2]


async def test_a_result_is_served_only_to_its_owner_and_source(client, db):
    headers = await _admin(client)
    ws, ds = await _source(client, headers)
    job = await _start(client, headers, ds, [("u0", "SELECT 1 AS one")])
    await _settle(job["id"])
    url = f"{API}/data-sources/{ds}/query-jobs/{job['id']}/results"

    assert (await client.get(f"{url}/missing", headers=headers)).status_code == 404
    assert (await client.get(f"{url}/..%2Fsecret", headers=headers)).status_code == 404

    db.add(User(username="other", password_hash=hash_password("pw-for-tests-only"), role="admin"))
    await db.commit()
    r = await client.post(f"{API}/auth/login", json={"username": "other", "password": "pw-for-tests-only"})
    other = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert (await client.get(f"{url}/u0", headers=other)).status_code == 404


async def test_keys_must_be_safe_and_unique(client):
    headers = await _admin(client)
    _, ds = await _source(client, headers)
    bad = await client.post(f"{API}/data-sources/{ds}/query-jobs", headers=headers, json={
        "label": "x", "queries": [{"key": "../x", "sql": "SELECT 1"}]})
    assert bad.status_code == 422
    dup = await client.post(f"{API}/data-sources/{ds}/query-jobs", headers=headers, json={
        "label": "x", "queries": [{"key": "a", "sql": "SELECT 1"}, {"key": "a", "sql": "SELECT 2"}]})
    assert dup.status_code == 400


async def test_cancel_interrupts_the_query_and_frees_the_lane(client, monkeypatch):
    monkeypatch.setattr(settings, "max_heavy_queries", 1)
    headers = await _admin(client)
    ws, ds = await _source(client, headers)
    slow = await _start(client, headers, ds, [("u0", SLOW)], label="Slow")
    await _until_running(slow["id"])
    queued = await _start(client, headers, ds, [("u0", "SELECT 2 AS two")], label="Next")
    await asyncio.sleep(0.2)
    # One heavy query at a time: the second waits for the first.
    assert (await _job(client, headers, ws, queued["id"]))["status"] == "queued"

    r = await client.post(f"{API}/jobs/{slow['id']}/cancel", headers=headers)
    assert r.status_code == 204
    await _settle(slow["id"])
    assert (await _job(client, headers, ws, slow["id"]))["status"] == "cancelled"
    # The DuckDB query itself stopped, not only the task awaiting it.
    await asyncio.wait_for(_gone(f"job:{slow['id']}"), 5.0)

    await _settle(queued["id"])
    assert (await _job(client, headers, ws, queued["id"]))["status"] == "done"


async def _gone(query_id: str) -> None:
    while query_id in query_cancel._running:
        await asyncio.sleep(0.02)


async def test_clearing_finished_jobs_drops_their_results(client):
    headers = await _admin(client)
    ws, ds = await _source(client, headers)
    job = await _start(client, headers, ds, [("u0", "SELECT 1 AS one")])
    await _settle(job["id"])
    assert query_jobs.results_dir(job["id"]).is_dir()
    assert (await client.delete(f"{API}/workspaces/{ws}/jobs", headers=headers)).status_code == 204
    assert not query_jobs.results_dir(job["id"]).exists()


async def test_each_query_has_its_own_access_log_line(client, monkeypatch):
    lines: list[dict] = []
    real = audit.write
    monkeypatch.setattr(audit, "write", lambda ctx: (lines.append(dict(ctx)), real(ctx)))
    headers = await _admin(client)
    _, ds = await _source(client, headers)
    job = await _start(client, headers, ds, [("u0", "SELECT 1 AS one"), ("u1", "SELECT 2 AS two")])
    await _settle(job["id"])
    queries = [ln for ln in lines if ln.get("action") == "query" and ln.get("via") == f"job:{job['id']}"]
    assert [ln["detail"] for ln in queries] == ["SELECT 1 AS one", "SELECT 2 AS two"]
    assert all(ln["username"] == "admin" and ln["data_source_id"] == ds for ln in queries)


async def test_a_failing_query_stops_the_job_and_keeps_its_whole_error(client):
    headers = await _admin(client)
    ws, ds = await _source(client, headers)
    job = await _start(client, headers, ds, [("u0", "SELECT 1 AS one"), ("u1", "SELECT * FROM missing_table"), ("u2", "SELECT 2")])
    await _settle(job["id"])
    failed = await _job(client, headers, ws, job["id"])
    assert failed["status"] == "error"
    assert failed["result"]["done"] == ["u0"]
    assert "missing_table" in failed["result"]["error"] and "\n" in failed["result"]["error"]
    ok = await client.get(f"{API}/data-sources/{ds}/query-jobs/{job['id']}/results/u0", headers=headers)
    assert ok.json() == {"rows": [{"one": 1}]}
