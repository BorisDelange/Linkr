"""A data-quality run the server owns (services/server_runs/dq.py): a rule set's
or a quality profile's checks on its database, each check's counts in the
checkpoint, and the report — assembled as the browser assembles it (the
fixture its twin test writes) — recorded in the history when the last lands."""

import asyncio
import json
from pathlib import Path

from app.services.server_runs.dq import build_report, entry_of, js_round, run_outcome
from tests.test_etl_jobs import _admin, _target

API = "/api/v1"
SLOW = "SELECT sum(a.i * b.i) AS violated_rows, 1 AS total_rows FROM range(200000) a(i), range(200000) b(i)"

_FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "web" / "src" / "lib" / "__fixtures__" / "dq-runs" / "report.json"
)


def test_the_report_is_the_browser_s():
    twin = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    checks = [case["check"] for case in twin["cases"]]
    entries = [
        {"ms": js_round(case["ms"]), "error": case["error"]} if "error" in case else entry_of(case["rows"], case["ms"])
        for case in twin["cases"]
    ]
    report = build_report(twin["dataSourceId"], twin["computedAt"], checks, entries)
    assert report == twin["expected"]["report"]
    score, duration_ms = run_outcome(report)
    assert {"score": score, "durationMs": duration_ms} == twin["expected"]["outcome"]


def _check(cid: str, sql: str, **over) -> dict:
    return {
        "id": cid, "name": f"Check {cid}", "description": "", "category": "completeness", "subcategory": None,
        "severity": "error", "origin": "ddl", "tableName": "t", "threshold": 0, "sql": sql, "exploreSql": None, **over,
    }


def _spec(ds: str, *checks: dict) -> dict:
    return {
        "label": "Quality", "dataSourceId": ds, "keepGoing": True, "meta": {"signature": "sig-1"},
        "checks": list(checks),
        "items": [{"key": f"c{i}", "sql": c["sql"], "what": c["name"], "pushdown": c["origin"] != "manual"} for i, c in enumerate(checks)],
    }


async def _rule_set(client, headers, ws: str, ds: str, rid="r1") -> str:
    r = await client.post(f"{API}/dq-rule-sets", headers=headers, json={
        "id": rid, "workspaceId": ws, "name": {"en": "Quality"}, "description": {}, "dataSourceId": ds,
    })
    assert r.status_code == 201, r.text
    return rid


async def _until(client, headers, kind, scope, statuses, timeout=60.0) -> dict:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        run = (await client.get(f"{API}/server-runs/latest?kind={kind}&scopeId={scope}", headers=headers)).json()
        if run and run["status"] in statuses:
            return run
        assert asyncio.get_running_loop().time() < deadline, run
        await asyncio.sleep(0.1)


async def test_a_rule_set_s_run_records_its_history_and_score(client):
    headers = await _admin(client)
    ws, ds = await _target(client, headers)
    rid = await _rule_set(client, headers, ws, ds)
    spec = _spec(
        ds,
        _check("a", "SELECT 0 AS violated_rows, 4 AS total_rows"),
        _check("b", "SELECT 1 AS violated_rows, 4 AS total_rows", severity="warning"),
        _check("c", "SELECT * FROM missing_table", origin="manual"),
        _check("d", "SELECT COUNT(*) AS violated_rows, COUNT(*) AS total_rows FROM t"),
    )
    r = await client.post(f"{API}/server-runs", headers=headers, json={"kind": "dq_rule_set", "scopeId": rid, "spec": spec})
    assert r.status_code == 202, r.text
    run = await _until(client, headers, "dq_rule_set", rid, {"done", "failed"})
    assert run["status"] == "done", run["error"]
    results = run["state"]["results"]
    assert {k: {x: v for x, v in e.items() if x != "ms"} for k, e in results.items() if "error" not in e} == {
        "c0": {"violated": 0, "total": 4}, "c1": {"violated": 1, "total": 4}, "c3": {"violated": 0, "total": 0},
    }
    assert "missing_table" in results["c2"]["error"]
    assert run["state"]["meta"] == {"signature": "sig-1"}

    history = (await client.get(f"{API}/dq-rule-sets/{rid}/runs", headers=headers)).json()
    assert [h["id"] for h in history] == [run["id"]]
    row = history[0]
    assert (row["status"], row["passed"], row["failed"], row["errors"], row["notApplicable"]) == ("success", 1, 1, 1, 1)
    # One passed of the three that apply: an error counts, as in the browser.
    assert row["score"] == 33 and row["dataSourceId"] == ds
    assert [r["status"] for r in row["report"]["results"]] == ["pass", "fail", "error", "not_applicable"]
    assert row["report"]["checks"][0]["id"] == "a"
    # Its job no longer shows the last check's SQL, but what the run did.
    job = (await client.get(f"{API}/jobs/{run['jobId']}?withInput=true", headers=headers)).json()
    assert job["input"] == "-- 4 checks run: 1 passed, 1 failed, 1 errors, 1 not applicable — score 33%"
    rule_set = (await client.get(f"{API}/dq-rule-sets/{rid}", headers=headers)).json()
    assert rule_set["lastScore"] == 33 and rule_set["status"] == "success" and rule_set["lastRunAt"] == row["completedAt"]


async def test_a_run_reads_its_own_database_only(client):
    headers = await _admin(client)
    ws, ds = await _target(client, headers)
    _, other = await _target(client, headers)
    rid = await _rule_set(client, headers, ws, ds)
    bare = await _rule_set(client, headers, ws, "", rid="r2")
    spec = _spec(ds, _check("a", "SELECT 0 AS violated_rows, 1 AS total_rows"))
    url = f"{API}/server-runs"
    r = await client.post(url, headers=headers, json={"kind": "dq_rule_set", "scopeId": rid, "spec": {**spec, "dataSourceId": other}})
    assert r.status_code == 400
    r = await client.post(url, headers=headers, json={"kind": "dq_rule_set", "scopeId": bare, "spec": spec})
    assert r.status_code == 400
    r = await client.post(url, headers=headers, json={"kind": "dq_rule_set", "scopeId": "missing", "spec": spec})
    assert r.status_code == 404
    # A check the spec does not describe: refused before it runs.
    r = await client.post(url, headers=headers, json={"kind": "dq_rule_set", "scopeId": rid, "spec": {**spec, "checks": []}})
    assert r.status_code == 422


async def test_a_profile_s_run_is_the_profile_s(client):
    headers = await _admin(client)
    ws, ds = await _target(client, headers)
    r = await client.post(f"{API}/dq-profiles", headers=headers, json={
        "id": "p1", "workspaceId": ws, "name": {"en": "ICU quality"}, "dataSourceId": ds, "sources": [],
    })
    assert r.status_code == 201, r.text
    check = _check("a", "SELECT 0 AS violated_rows, 1 AS total_rows", ruleSetId="r9", ruleSetName="Base", checkKey="a")
    r = await client.post(f"{API}/server-runs", headers=headers, json={"kind": "dq_profile", "scopeId": "p1", "spec": _spec(ds, check)})
    assert r.status_code == 202, r.text
    run = await _until(client, headers, "dq_profile", "p1", {"done", "failed"})
    assert run["status"] == "done", run["error"]
    history = (await client.get(f"{API}/dq-profiles/p1/runs", headers=headers)).json()
    assert [h["id"] for h in history] == [run["id"]] and history[0]["profileId"] == "p1"
    assert history[0]["report"]["checks"][0]["ruleSetName"] == "Base"
    assert (await client.get(f"{API}/dq-profiles/p1", headers=headers)).json()["lastScore"] == 100


async def test_paused_then_resumed_at_the_check_it_cut(client, monkeypatch):
    headers = await _admin(client)
    ws, ds = await _target(client, headers)
    rid = await _rule_set(client, headers, ws, ds)
    run = (await client.post(f"{API}/server-runs", headers=headers, json={"kind": "dq_rule_set", "scopeId": rid, "spec": _spec(
        ds,
        _check("first", "SELECT 0 AS violated_rows, 1 AS total_rows"),
        _check("slow", SLOW),
        _check("last", "SELECT 0 AS violated_rows, 1 AS total_rows"),
    )})).json()
    deadline = asyncio.get_running_loop().time() + 30
    while (await _until(client, headers, "dq_rule_set", rid, {"running", "done"}))["state"].get("next", 0) < 1:
        assert asyncio.get_running_loop().time() < deadline
        await asyncio.sleep(0.05)
    await asyncio.sleep(0.3)
    await client.post(f"{API}/server-runs/{run['id']}/pause", headers=headers)
    paused = await _until(client, headers, "dq_rule_set", rid, {"paused"})
    assert paused["state"]["next"] == 1 and list(paused["state"]["results"]) == ["c0"]
    job = (await client.get(f"{API}/jobs/{paused['jobId']}?withInput=true", headers=headers)).json()
    assert job["input"] == "-- Paused at check 2 of 3, after 1 checks"
    # Nothing recorded while it waits.
    assert (await client.get(f"{API}/dq-rule-sets/{rid}/runs", headers=headers)).json() == []

    from app.services.server_runs import executor

    query = executor.QueryingExecutor.query

    async def quick(self, sql, what, **kw):
        return await query(self, "SELECT 0 AS violated_rows, 1 AS total_rows" if sql == SLOW else sql, what, **kw)

    monkeypatch.setattr(executor.QueryingExecutor, "query", quick)
    await client.post(f"{API}/server-runs/{run['id']}/resume", headers=headers)
    done = await _until(client, headers, "dq_rule_set", rid, {"done", "failed"})
    assert done["status"] == "done", done["error"]
    assert done["attempt"] == 2 and list(done["state"]["results"]) == ["c0", "c1", "c2"]
    history = (await client.get(f"{API}/dq-rule-sets/{rid}/runs", headers=headers)).json()
    assert len(history) == 1 and history[0]["passed"] == 3


async def test_a_rule_set_deleted_takes_its_runs(client):
    headers = await _admin(client)
    ws, ds = await _target(client, headers)
    rid = await _rule_set(client, headers, ws, ds)
    await client.post(f"{API}/server-runs", headers=headers, json={"kind": "dq_rule_set", "scopeId": rid, "spec": _spec(
        ds, _check("slow", SLOW),
    )})
    await _until(client, headers, "dq_rule_set", rid, {"running"})
    assert (await client.delete(f"{API}/dq-rule-sets/{rid}", headers=headers)).status_code == 204
    from sqlalchemy import select

    from app.core import database
    from app.models.server_run import ServerRun

    async with database.async_session() as db:
        assert (await db.execute(select(ServerRun).where(ServerRun.scope_id == rid))).scalars().all() == []
