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


async def test_the_query_in_flight_reports_how_far_it_has_read(client, monkeypatch):
    monkeypatch.setattr(query_jobs, "PROGRESS_POLL_SECONDS", 0.01)
    monkeypatch.setattr(query_cancel, "progress", lambda query_id, owner: 42.0)
    reports: list[tuple[dict, int]] = []
    real_result, real_progress = jobs.JobHandle.set_result, jobs.JobHandle.progress
    seen: dict = {}

    async def set_result(self, result):
        seen["result"] = dict(result)
        await real_result(self, result)

    async def progress(self, pct):
        if "reading" in seen.get("result", {}):
            reports.append((seen["result"], pct))
        await real_progress(self, pct)

    monkeypatch.setattr(jobs.JobHandle, "set_result", set_result)
    monkeypatch.setattr(jobs.JobHandle, "progress", progress)
    headers = await _admin(client)
    ws, ds = await _source(client, headers)
    job = await _start(client, headers, ds, [("u0", "SELECT 1 AS one"), ("u1", SLOW)])

    async def reported():
        while not any(r["current"] == "u1" for r, _ in reports):
            await asyncio.sleep(0.02)

    # Generous: under the whole suite's load the job can take a while to start.
    await asyncio.wait_for(reported(), 30)
    await client.post(f"{API}/jobs/{job['id']}/cancel", headers=headers)
    await _settle(job["id"])

    result, pct = next((r, p) for r, p in reports if r["current"] == "u1")
    # The second of two queries, 42 % read: the job is 71 % through.
    assert result["reading"] == 42 and result["done"] == ["u0"] and pct == 71


async def _concept_run(client, headers, ds, run_id: str) -> None:
    r = await client.put(f"{API}/data-sources/{ds}/concept-cache/run", headers=headers, json={
        "manifest": {"runId": run_id, "units": []}, "reset": True,
    })
    assert r.status_code == 204, r.text


async def test_concept_units_run_as_a_job_and_are_kept_as_the_run_units(client):
    headers = await _admin(client)
    ws, ds = await _source(client, headers)
    await _concept_run(client, headers, ds, "run-a")
    r = await client.post(f"{API}/data-sources/{ds}/concept-cache/units-job", headers=headers, json={
        "label": "Concepts", "runId": "run-a",
        "units": [{"key": "records-0", "sql": "SELECT x AS concept_id, 1 AS n FROM t"}],
    })
    assert r.status_code == 202, r.text
    await _settle(r.json()["id"])

    done = await _job(client, headers, ws, r.json()["id"])
    assert done["status"] == "done" and done["result"]["done"] == ["records-0"]
    # Kept in the concept cache, not as a result for the client to fetch.
    assert done["result"]["rows"] == {}
    status = (await client.get(f"{API}/data-sources/{ds}/concept-cache", headers=headers)).json()
    assert status["run"]["doneUnits"] == ["records-0"] and not status["exists"]


async def test_a_concept_job_assembles_the_list_between_its_units(client):
    headers = await _admin(client)
    ws, ds = await _source(client, headers)
    await _concept_run(client, headers, ds, "run-a")
    r = await client.post(f"{API}/data-sources/{ds}/concept-cache/units-job", headers=headers, json={
        "label": "Concepts", "runId": "run-a", "units": [
            {"key": "records-0", "sql": "SELECT x AS concept_id, 1 AS n FROM t"},
            {"key": "assemble-0", "sql": "SELECT concept_id, sum(n) AS n FROM memory.main._concept_counts GROUP BY 1"},
        ],
    })
    await _settle(r.json()["id"])
    assert (await _job(client, headers, ws, r.json()["id"]))["status"] == "done"
    status = (await client.get(f"{API}/data-sources/{ds}/concept-cache", headers=headers)).json()
    assert status["exists"] and status["run"]["doneUnits"] == ["records-0"]
    page = await client.post(f"{API}/data-sources/{ds}/concept-cache/query", headers=headers, json={
        "sql": "SELECT count(*) AS c FROM concepts"})
    assert page.json()["rows"] == [{"c": 10}]


async def test_concept_units_of_a_replaced_run_are_refused(client):
    headers = await _admin(client)
    _, ds = await _source(client, headers)
    await _concept_run(client, headers, ds, "run-a")
    await _concept_run(client, headers, ds, "run-b")
    r = await client.post(f"{API}/data-sources/{ds}/concept-cache/units-job", headers=headers, json={
        "label": "Concepts", "runId": "run-a", "units": [{"key": "records-0", "sql": "SELECT 1 AS concept_id"}],
    })
    assert r.status_code == 409


async def test_keep_going_records_a_failing_query_and_runs_the_next(client):
    headers = await _admin(client)
    ws, ds = await _source(client, headers)
    r = await client.post(f"{API}/data-sources/{ds}/query-jobs", headers=headers, json={
        "label": "Checks", "keepGoing": True, "queries": [
            {"key": "c0", "sql": "SELECT * FROM missing_table"},
            {"key": "c1", "sql": "SELECT count(*) AS n FROM t", "pushdown": False},
        ],
    })
    assert r.status_code == 202, r.text
    await _settle(r.json()["id"])
    job = await _job(client, headers, ws, r.json()["id"])
    assert job["status"] == "done" and job["result"]["done"] == ["c0", "c1"]
    assert "missing_table" in job["result"]["errors"]["c0"] and "c1" not in job["result"]["errors"]
    assert set(job["result"]["ms"]) == {"c0", "c1"}
    ok = await client.get(f"{API}/data-sources/{ds}/query-jobs/{job['id']}/results/c1", headers=headers)
    assert ok.json() == {"rows": [{"n": 10}]}
