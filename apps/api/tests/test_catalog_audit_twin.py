"""A data catalog's disclosure audit computed here finds what the browser's
`auditPublished` finds (the fixture is written by apps/web src/lib/data-catalog/
audit.twin.test.ts): the same systems, unknowns, findings, examples and order —
whole, and resumed from a checkpoint. Then the run itself: started, followed,
paused midway and resumed to the same audit."""

import asyncio
import json
from pathlib import Path

import pytest

from app.schemas.catalog_audit_run import CatalogAuditRunSpec
from app.services.server_runs import executor, query_list
from app.services.server_runs.catalog_audit import compute
from app.services.server_runs.catalog_audit import executor as audit_executor
from tests.test_concept_stats_cache import _admin_headers, _workspace

API = "/api/v1"
_FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "web" / "src" / "lib" / "__fixtures__" / "catalog-audit" / "audit.json"
)
TWIN = json.loads(_FIXTURE.read_text(encoding="utf-8"))
CASES = {case["name"]: case for case in TWIN["cases"]}


def _input(case: dict) -> dict:
    """As the run reads it: through its spec's model."""
    spec = CatalogAuditRunSpec.model_validate({"label": "Audit", "input": case["input"], "meta": _meta(case)})
    return spec.input.model_dump(by_alias=True)


def _meta(case: dict) -> dict:
    return {"threshold": case["input"]["threshold"], "mode": "replace", "noise": case["input"]["noise"], "resultsComputedAt": "r1"}


def test_the_variable_order_is_the_browser_s():
    assert list(compute.VARIABLE_ORDER) == TWIN["variableOrder"]


@pytest.mark.parametrize("name", list(CASES))
def test_the_audit_finds_what_the_browser_finds(name):
    case = CASES[name]
    assert compute.audit_published(_input(case)) == case["expected"]


@pytest.mark.parametrize("name", ["generated", "suppressed-categories", "concept-list-with-stays"])
def test_resumed_from_a_checkpoint_it_finds_the_same(name):
    case = CASES[name]
    inp = _input(case)
    first = compute.Audit(inp)
    half = len(first.components) // 2
    for n in range(half):
        first.solve(n)
    checkpoint = json.loads(json.dumps(first.checkpoint(half)))
    second = compute.Audit(inp, checkpoint)
    for n in range(half, len(second.components)):
        second.solve(n)
    assert second.result() == case["expected"]


def test_the_cell_keys_stay_integers():
    case = CASES["atrovent"]
    tables = compute.tables_of(_input(case))
    assert list(tables["concept-period"].cells) == ["0,0", "0,1"]


# --- the run, on the server ---------------------------------------------------


async def _catalog(client) -> tuple[dict, str]:
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    r = await client.post(f"{API}/data-catalogs", headers=headers, json={
        "id": "audit-catalog", "workspaceId": ws, "name": {"en": "Audit"}, "dataSourceId": "",
        "variables": {}, "crossings": [], "anonymization": {"threshold": 10, "mode": "replace"},
    })
    assert r.status_code == 201, r.text
    return headers, r.json()["id"]


def _spec(name: str = "generated") -> dict:
    case = CASES[name]
    return {"label": "Disclosure audit", "input": case["input"], "meta": _meta(case)}


async def _until(client, headers, catalog, statuses, timeout=60.0) -> dict:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        run = (await client.get(f"{API}/server-runs/latest?kind=catalog_audit&scopeId={catalog}", headers=headers)).json()
        if run and run["status"] in statuses:
            return run
        assert asyncio.get_running_loop().time() < deadline, run
        await asyncio.sleep(0.05)


def _expected(name: str = "generated") -> dict:
    return {**_meta(CASES[name]), **CASES[name]["expected"]}


def _stamped(audit: dict) -> dict:
    assert audit["computedAt"] and audit["durationMs"] >= 0
    return {k: v for k, v in audit.items() if k not in ("computedAt", "durationMs")}


async def test_the_run_gives_the_browser_s_audit(client):
    headers, catalog = await _catalog(client)
    r = await client.post(f"{API}/server-runs", headers=headers, json={"kind": "catalog_audit", "scopeId": catalog, "spec": _spec()})
    assert r.status_code == 202, r.text
    run = await _until(client, headers, catalog, {"done", "failed"})
    assert run["status"] == "done", run["error"]
    assert run["state"]["meta"] == _meta(CASES["generated"])
    assert run["state"]["next"] == run["state"]["total"] == CASES["generated"]["expected"]["components"]
    audit = (await client.get(f"{API}/server-runs/{run['id']}/results/audit", headers=headers)).json()["rows"]
    assert audit["computedAt"] == run["state"]["computedAt"]
    assert _stamped(audit) == _expected()

    # The catalog deleted, its runs and their files go with it.
    assert (await client.delete(f"{API}/data-catalogs/{catalog}", headers=headers)).status_code == 204
    assert (await client.get(f"{API}/server-runs/{run['id']}/results/audit", headers=headers)).status_code == 404
    assert not executor.run_dir(run["id"]).exists()


async def test_paused_midway_then_resumed_to_the_same_audit(client, monkeypatch):
    monkeypatch.setattr(audit_executor, "CHECKPOINT_EVERY", 5)
    monkeypatch.setattr(audit_executor, "PACE_S", 0.02)
    headers, catalog = await _catalog(client)
    run = (await client.post(f"{API}/server-runs", headers=headers, json={"kind": "catalog_audit", "scopeId": catalog, "spec": _spec()})).json()
    while (await _until(client, headers, catalog, {"running"}))["state"].get("next", 0) < 20:
        await asyncio.sleep(0.05)
    await client.post(f"{API}/server-runs/{run['id']}/pause", headers=headers)
    paused = await _until(client, headers, catalog, {"paused"})
    total = CASES["generated"]["expected"]["components"]
    assert 20 <= paused["state"]["next"] < total
    assert query_list.read_result(run["id"], "audit") is None

    monkeypatch.setattr(audit_executor, "PACE_S", 0.0)
    await client.post(f"{API}/server-runs/{run['id']}/resume", headers=headers)
    done = await _until(client, headers, catalog, {"done", "failed"})
    assert done["status"] == "done", done["error"]
    assert done["attempt"] == 2
    assert _stamped(query_list.read_result(run["id"], "audit")) == _expected()


async def test_a_start_checks_its_catalog_and_spec(client):
    headers, catalog = await _catalog(client)
    url = f"{API}/server-runs"
    assert (await client.post(url, headers=headers, json={"kind": "catalog_audit", "scopeId": "no-such", "spec": _spec()})).status_code == 404
    bad = {**_spec(), "meta": {**_spec()["meta"], "mode": "blur"}}
    assert (await client.post(url, headers=headers, json={"kind": "catalog_audit", "scopeId": catalog, "spec": bad})).status_code == 422


async def test_a_reader_may_follow_but_not_start_it(client, monkeypatch):
    headers, catalog = await _catalog(client)
    from app.api.v1.routes import server_runs as routes

    async def check(db, workspace_id, user, permission):
        if permission != "catalog:read":
            from fastapi import HTTPException

            raise HTTPException(403, "Forbidden")

    monkeypatch.setattr(routes, "check_workspace_permission", check)
    url = f"{API}/server-runs"
    assert (await client.post(url, headers=headers, json={"kind": "catalog_audit", "scopeId": catalog, "spec": _spec("atrovent")})).status_code == 403
    assert (await client.get(f"{url}/latest?kind=catalog_audit&scopeId={catalog}", headers=headers)).status_code == 200
