"""A list of queries the server runs (services/server_runs/query_list.py): each
in turn, its rows kept for the page to read, a resume going on at the first one
not done. Here as a pipeline's Quality check (`etl_quality`)."""

import asyncio

from app.services.server_runs import query_list
from tests.test_etl_jobs import _admin, _target
from tests.test_server_run_etl import _pipeline

API = "/api/v1"
SLOW = "SELECT sum(a.i * b.i) AS s FROM range(200000) a(i), range(200000) b(i)"


async def _setup(client):
    headers = await _admin(client)
    ws, ds = await _target(client, headers)
    pid = await _pipeline(client, headers, ws, ds)
    return headers, pid


def _spec(*items, keep_going=False) -> dict:
    return {
        "label": "Quality", "keepGoing": keep_going, "meta": {"fingerprint": "run-1"},
        "items": [{"key": key, "sql": sql, "what": f"query {key}"} for key, sql in items],
    }


async def _until(client, headers, pid, statuses, timeout=60.0) -> dict:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        run = (await client.get(f"{API}/server-runs/latest?kind=etl_quality&scopeId={pid}", headers=headers)).json()
        if run and run["status"] in statuses:
            return run
        assert asyncio.get_running_loop().time() < deadline, run
        await asyncio.sleep(0.1)


async def test_each_query_runs_and_its_rows_are_kept(client):
    headers, pid = await _setup(client)
    r = await client.post(f"{API}/server-runs", headers=headers, json={"kind": "etl_quality", "scopeId": pid, "spec": _spec(
        ("a", "SELECT 1 AS x UNION ALL SELECT 2"), ("b", "SELECT 'y' AS label"),
    )})
    assert r.status_code == 202, r.text
    run = await _until(client, headers, pid, {"done", "failed"})
    assert run["status"] == "done", run["error"]
    assert run["state"]["rows"] == {"a": 2, "b": 1}
    assert run["state"]["meta"] == {"fingerprint": "run-1"}
    a = await client.get(f"{API}/server-runs/{run['id']}/results/a", headers=headers)
    assert a.json() == {"rows": [{"x": 1}, {"x": 2}]}
    assert (await client.get(f"{API}/server-runs/{run['id']}/results/missing", headers=headers)).status_code == 404
    assert (await client.get(f"{API}/server-runs/{run['id']}/results/..%2Fa", headers=headers)).status_code == 404


async def test_a_failing_query_is_recorded_when_the_list_keeps_going(client):
    headers, pid = await _setup(client)
    await client.post(f"{API}/server-runs", headers=headers, json={"kind": "etl_quality", "scopeId": pid, "spec": _spec(
        ("bad", "SELECT * FROM missing_table"), ("good", "SELECT 1 AS x"), keep_going=True,
    )})
    run = await _until(client, headers, pid, {"done", "failed"})
    assert run["status"] == "done"
    assert "missing_table" in run["state"]["errors"]["bad"] and run["state"]["rows"] == {"good": 1}


async def test_a_failing_query_fails_the_list_otherwise(client):
    headers, pid = await _setup(client)
    await client.post(f"{API}/server-runs", headers=headers, json={"kind": "etl_quality", "scopeId": pid, "spec": _spec(
        ("bad", "SELECT * FROM missing_table"), ("good", "SELECT 1 AS x"),
    )})
    run = await _until(client, headers, pid, {"done", "failed"})
    assert run["status"] == "failed" and "missing_table" in run["error"]
    assert run["state"].get("rows") is None


async def test_paused_then_resumed_at_the_query_it_cut(client, monkeypatch):
    headers, pid = await _setup(client)
    run = (await client.post(f"{API}/server-runs", headers=headers, json={"kind": "etl_quality", "scopeId": pid, "spec": _spec(
        ("first", "SELECT 1 AS x"), ("slow", SLOW), ("last", "SELECT 3 AS x"),
    )})).json()
    deadline = asyncio.get_running_loop().time() + 30
    while (await _until(client, headers, pid, {"running", "done"}))["state"].get("next", 0) < 1:
        assert asyncio.get_running_loop().time() < deadline
        await asyncio.sleep(0.05)
    await asyncio.sleep(0.3)
    await client.post(f"{API}/server-runs/{run['id']}/pause", headers=headers)
    paused = await _until(client, headers, pid, {"paused"})
    assert paused["state"]["next"] == 1 and paused["state"]["rows"] == {"first": 1}
    # The slow one made quick, as if the database had warmed: the list goes on there.
    from app.services.server_runs import executor

    query = executor.QueryingExecutor.query

    async def quick(self, sql, what, **kw):
        return await query(self, "SELECT 2 AS x" if sql == SLOW else sql, what, **kw)

    monkeypatch.setattr(executor.QueryingExecutor, "query", quick)
    await client.post(f"{API}/server-runs/{run['id']}/resume", headers=headers)
    done = await _until(client, headers, pid, {"done", "failed"})
    assert done["status"] == "done", done["error"]
    assert done["attempt"] == 2 and done["state"]["rows"] == {"first": 1, "slow": 1, "last": 1}
    assert query_list.read_result(done["id"], "first") == [{"x": 1}]


async def test_a_database_s_statistics_run_on_its_database(client):
    headers = await _admin(client)
    _, ds = await _target(client, headers)
    url = f"{API}/server-runs"
    refused = await client.post(url, headers=headers, json={"kind": "database_stats", "scopeId": f"{ds}:other", "spec": _spec(("a", "SELECT 1"))})
    assert refused.status_code == 400
    r = await client.post(url, headers=headers, json={"kind": "database_stats", "scopeId": f"{ds}:counts", "spec": _spec(
        ("t0", "SELECT COUNT(*) AS cnt FROM t"),
    )})
    assert r.status_code == 202, r.text
    deadline = asyncio.get_running_loop().time() + 30
    while (run := (await client.get(f"{url}/latest?kind=database_stats&scopeId={ds}:counts", headers=headers)).json())["status"] not in ("done", "failed"):
        assert asyncio.get_running_loop().time() < deadline
        await asyncio.sleep(0.1)
    assert run["status"] == "done", run["error"]
    assert (await client.get(f"{url}/{run['id']}/results/t0", headers=headers)).json() == {"rows": [{"cnt": 0}]}


async def test_a_cohort_s_run_reads_its_database_and_goes_with_it(client, monkeypatch, tmp_path_factory):
    from tests.test_concept_run_twin import _parquet_source

    headers, source = await _parquet_source(client, monkeypatch, tmp_path_factory)
    ws = (await client.get(f"{API}/data-sources/{source}", headers=headers)).json()["workspaceId"]
    _, other = await _target(client, headers)
    uid = (await client.post(f"{API}/projects", headers=headers, json={
        "name": {"en": "P"}, "workspaceId": ws, "linkedDataSourceIds": [source],
    })).json()["uid"]
    r = await client.post(f"{API}/cohorts", headers=headers, json={
        "id": "c1", "projectUid": uid, "name": {"en": "C"}, "level": "patient", "dataSourceId": source,
    })
    assert r.status_code == 201, r.text
    spec = _spec(("results", "SELECT person_id FROM person ORDER BY person_id LIMIT 3"))
    url = f"{API}/server-runs"
    # Another database than the cohort's project reads: refused.
    refused = await client.post(url, headers=headers, json={"kind": "cohort_run", "scopeId": "c1", "spec": {**spec, "meta": {"dataSourceId": other}}})
    assert refused.status_code == 400
    r = await client.post(url, headers=headers, json={"kind": "cohort_run", "scopeId": "c1", "spec": {**spec, "meta": {"dataSourceId": source}}})
    assert r.status_code == 202, r.text
    deadline = asyncio.get_running_loop().time() + 30
    while (run := (await client.get(f"{url}/latest?kind=cohort_run&scopeId=c1", headers=headers)).json())["status"] not in ("done", "failed"):
        assert asyncio.get_running_loop().time() < deadline
        await asyncio.sleep(0.1)
    assert run["status"] == "done", run["error"]
    assert query_list.read_result(run["id"], "results") == [{"person_id": 1}, {"person_id": 2}, {"person_id": 3}]
    # Its figures, a run of their own on the same database.
    r = await client.post(url, headers=headers, json={"kind": "cohort_figures", "scopeId": "c1", "spec": {
        **_spec(("sections", "SELECT COUNT(*) AS n FROM person")), "meta": {"dataSourceId": source},
    }})
    assert r.status_code == 202, r.text
    while (figures := (await client.get(f"{url}/latest?kind=cohort_figures&scopeId=c1", headers=headers)).json())["status"] not in ("done", "failed"):
        assert asyncio.get_running_loop().time() < deadline
        await asyncio.sleep(0.1)
    assert figures["status"] == "done", figures["error"]

    # The cohort deleted, its members' ids and its figures go with it.
    assert (await client.delete(f"{API}/cohorts/c1", headers=headers)).status_code == 204
    assert query_list.read_result(run["id"], "results") is None
    assert query_list.read_result(figures["id"], "sections") is None
    assert (await client.get(f"{url}/{run['id']}/results/results", headers=headers)).status_code == 404
