"""An ETL pipeline run by the server (services/server_runs/etl.py): its scripts in
order on the managed target, one run per target, a script the step a pause
cuts and a resume runs again, the run's history written by the server."""

import asyncio

import duckdb
from sqlalchemy import update

from app.core import database
from app.models.etl_pipeline import EtlRunHistory
from app.models.server_run import ServerRun
from app.services.data import managed_db
from app.services.data_source_service import _etl_runs
from app.services.server_runs import runs
from tests.test_etl_jobs import _admin, _target

API = "/api/v1"
SLOW = "SELECT sum(a.i * b.i) FROM range(200000) a(i), range(200000) b(i);"


async def _pipeline(client, headers, ws, ds, pid="p1") -> str:
    r = await client.post(f"{API}/etl-pipelines", headers=headers, json={
        "id": pid, "workspaceId": ws, "name": {"en": pid}, "targetDataSourceId": ds,
    })
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _spec(pipeline: str, *scripts: str | None) -> dict:
    return {
        "label": "Pipeline", "pipelineId": pipeline,
        "steps": [{"fileId": f"f{n}", "name": f"script {n}", "sql": sql} for n, sql in enumerate(scripts)],
    }


async def _until(client, headers, ds, statuses, timeout=60.0) -> dict:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        run = (await client.get(f"{API}/server-runs/latest?kind=etl&scopeId={ds}", headers=headers)).json()
        if run and run["status"] in statuses:
            return run
        assert asyncio.get_running_loop().time() < deadline, run
        await asyncio.sleep(0.1)


def _count(ds: str) -> int:
    con = duckdb.connect(str(managed_db.path_for(ds)), read_only=True)
    try:
        return con.execute("SELECT count(*) FROM t").fetchone()[0]
    finally:
        con.close()


async def _history(run_id: str) -> EtlRunHistory:
    async with database.async_session() as db:
        return await db.get(EtlRunHistory, run_id)


async def test_the_scripts_run_in_order_to_the_end(client):
    headers = await _admin(client)
    ws, ds = await _target(client, headers)
    pid = await _pipeline(client, headers, ws, ds)
    # A variable set by one statement is read by the next: a script is one session.
    r = await client.post(f"{API}/server-runs", headers=headers, json={"kind": "etl", "scopeId": ds, "spec": _spec(
        pid,
        "SET VARIABLE n = 3; INSERT INTO target.t SELECT range FROM range(getvariable('n'));",
        None,
        "INSERT INTO target.t VALUES (99);",
    )})
    assert r.status_code == 202, r.text
    run = await _until(client, headers, ds, {"done", "failed"})
    assert run["status"] == "done", run["error"]
    assert run["state"]["next"] == 3
    assert [(s["fileId"], s["status"]) for s in run["state"]["scripts"]] == [("f0", "success"), ("f1", "skipped"), ("f2", "success")]
    assert _count(ds) == 4
    history = await _history(run["id"])
    assert history.status == "success" and history.completed_at and history.pipeline_id == pid
    assert [s["status"] for s in history.scripts] == ["success", "skipped", "success"]
    assert ds not in _etl_runs


async def test_one_run_per_target_whatever_the_pipeline(client):
    headers = await _admin(client)
    ws, ds = await _target(client, headers)
    first_pipeline = await _pipeline(client, headers, ws, ds, "p1")
    second_pipeline = await _pipeline(client, headers, ws, ds, "p2")
    first = (await client.post(f"{API}/server-runs", headers=headers, json={"kind": "etl", "scopeId": ds, "spec": _spec(first_pipeline, SLOW)})).json()
    second = (await client.post(f"{API}/server-runs", headers=headers, json={"kind": "etl", "scopeId": ds, "spec": _spec(second_pipeline, "SELECT 1;")})).json()
    assert second["id"] == first["id"]
    while ds not in _etl_runs:
        await asyncio.sleep(0.05)
    await client.post(f"{API}/server-runs/{first['id']}/cancel", headers=headers)
    cancelled = await _until(client, headers, ds, {"cancelled"})
    assert (await _history(cancelled["id"])).status == "error"


async def test_a_pause_cuts_the_script_and_a_resume_runs_it_again_fixed(client):
    headers = await _admin(client)
    ws, ds = await _target(client, headers)
    pid = await _pipeline(client, headers, ws, ds)
    run = (await client.post(f"{API}/server-runs", headers=headers, json={"kind": "etl", "scopeId": ds, "spec": _spec(
        pid, "INSERT INTO target.t VALUES (1), (2), (3);", SLOW,
    )})).json()
    # Into the second script's statement.
    deadline = asyncio.get_running_loop().time() + 30
    while ds not in _etl_runs or (await _until(client, headers, ds, {"running", "done", "failed"}))["state"].get("next", 0) < 1:
        assert asyncio.get_running_loop().time() < deadline
        await asyncio.sleep(0.05)
    r = await client.post(f"{API}/server-runs/{run['id']}/pause", headers=headers)
    assert r.json()["status"] in ("pausing", "paused")
    paused = await _until(client, headers, ds, {"paused"})
    assert paused["state"]["next"] == 1
    assert [s["status"] for s in paused["state"]["scripts"]] == ["success", "stopped"]
    # Paused, the run waits: its history entry too.
    assert (await _history(run["id"])).status == "running"
    assert ds not in _etl_runs

    # Fixed while it waited, and sent alone as the page sends the scripts left: the
    # resume runs the new second script, not the first again.
    left = _spec(pid, "INSERT INTO target.t VALUES (1), (2), (3);", "INSERT INTO target.t VALUES (4);")
    left["steps"] = left["steps"][1:]
    resumed = await client.post(f"{API}/server-runs/{run['id']}/resume", headers=headers, json={"spec": left})
    assert resumed.status_code == 200, resumed.text
    done = await _until(client, headers, ds, {"done", "failed"})
    assert done["status"] == "done", done["error"]
    assert done["attempt"] == 2 and _count(ds) == 4
    assert [(s["fileId"], s["status"]) for s in done["state"]["scripts"]] == [("f0", "success"), ("f1", "success")]
    assert (await _history(run["id"])).status == "success"


async def test_a_failing_script_fails_the_run_and_stops_it_there(client):
    headers = await _admin(client)
    ws, ds = await _target(client, headers)
    pid = await _pipeline(client, headers, ws, ds)
    await client.post(f"{API}/server-runs", headers=headers, json={"kind": "etl", "scopeId": ds, "spec": _spec(
        pid, "SELECT * FROM target.missing_table;", "INSERT INTO target.t VALUES (1);",
    )})
    failed = await _until(client, headers, ds, {"done", "failed"})
    assert failed["status"] == "failed" and "missing_table" in failed["error"]
    script = failed["state"]["scripts"][0]
    assert script["status"] == "error" and "missing_table" in script["error"]
    assert len(failed["state"]["scripts"]) == 1 and _count(ds) == 0
    assert (await _history(failed["id"])).status == "error"


async def test_a_pipeline_aimed_elsewhere_is_refused(client):
    headers = await _admin(client)
    ws, ds = await _target(client, headers)
    other = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "o", "name": "o", "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "managed": True},
    })).json()["id"]
    pid = await _pipeline(client, headers, ws, other)
    r = await client.post(f"{API}/server-runs", headers=headers, json={"kind": "etl", "scopeId": ds, "spec": _spec(pid, "SELECT 1;")})
    assert r.status_code == 404


async def test_a_restart_leaves_a_cut_pipeline_to_its_user(client):
    headers = await _admin(client)
    ws, ds = await _target(client, headers)
    pid = await _pipeline(client, headers, ws, ds)
    run = (await client.post(f"{API}/server-runs", headers=headers, json={"kind": "etl", "scopeId": ds, "spec": _spec(pid, SLOW)})).json()
    await _until(client, headers, ds, {"running"})
    await client.post(f"{API}/server-runs/{run['id']}/pause", headers=headers)
    await _until(client, headers, ds, {"paused"})
    # As an earlier process would have left it: still running, under another boot.
    async with database.async_session() as db:
        await db.execute(update(ServerRun).where(ServerRun.id == run["id"]).values(status="running", boot_id="an-earlier-boot"))
        await db.commit()
    await runs.recover_on_startup()
    left = (await client.get(f"{API}/server-runs/latest?kind=etl&scopeId={ds}", headers=headers)).json()
    assert left["status"] == "interrupted"
