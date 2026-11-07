"""What a DQ or ETL run stored about a database answers to the right to read that
database, and a stored run keeps none of the row values a failed statement quoted."""

import pytest

from app.models.role import Role
from tests.test_database_binding import _database, _member, _workspace
from tests.test_ide_files import _admin_headers

API = "/api/v1"
ROW_VALUE = "ZZDUMMYROW77"
DRIVER_ERROR = f"Conversion Error: Could not convert string '{ROW_VALUE}' to INT32"
STARTED = "2026-01-01T00:00:00Z"


@pytest.fixture
async def world(client, db, seed_roles):
    admin = await _admin_headers(client)
    ws = await _workspace(client, admin)
    source = await _database(client, admin, ws, "local")
    db.add(Role(name="results-only", scope="workspace", permissions=[
        "data-quality:read", "data-quality:write", "etl:read", "etl:write",
    ]))
    await db.commit()
    r = await client.post(f"{API}/dq-rule-sets", headers=admin, json={
        "id": "r1", "workspaceId": ws, "name": {"en": "r"}, "dataSourceId": source,
    })
    assert r.status_code == 201, r.text
    r = await client.post(f"{API}/etl-pipelines", headers=admin, json={
        "id": "p1", "workspaceId": ws, "name": {"en": "p"}, "sourceDataSourceId": source,
    })
    assert r.status_code == 201, r.text
    return {
        "admin": admin, "ws": ws, "source": source,
        "outsider": await _member(client, db, ws, "results-only", role="results-only"),
        "editor": await _member(client, db, ws, "editor"),
    }


def _dq_run(run_id: str, source: str) -> dict:
    return {
        "id": run_id, "ruleSetId": "r1", "dataSourceId": source, "startedAt": STARTED, "status": "error",
        "report": {"results": [{"checkId": "c1", "status": "error", "violatedRows": 0, "totalRows": 0,
                                "sql": "SELECT 1", "errorMessage": DRIVER_ERROR}]},
    }


def _etl_run(run_id: str) -> dict:
    return {
        "id": run_id, "pipelineId": "p1", "startedAt": STARTED, "status": "error",
        "scripts": [{"id": "l1", "fileId": "f1", "status": "error", "error": DRIVER_ERROR, "output": DRIVER_ERROR}],
    }


async def test_stored_results_answer_to_the_right_to_read_the_database(client, world):
    admin, outsider, editor = world["admin"], world["outsider"], world["editor"]
    assert (await client.post(f"{API}/dq-run-history", headers=admin, json=_dq_run("d1", world["source"]))).status_code == 201
    assert (await client.post(f"{API}/etl-runs", headers=admin, json=_etl_run("e1"))).status_code == 201
    cache = {"computedAt": STARTED, "payload": {"n": 3}}
    assert (await client.put(f"{API}/etl-pipelines/p1/quality-cache", headers=admin, json=cache)).status_code == 200

    reads = [f"{API}/dq-rule-sets/r1/runs", f"{API}/etl-pipelines/p1/runs", f"{API}/etl-pipelines/p1/quality-cache"]
    for url in reads:
        assert (await client.get(url, headers=outsider)).status_code == 403, url
        assert (await client.get(url, headers=editor)).status_code == 200, url
    assert (await client.patch(f"{API}/dq-run-history/d1", headers=outsider, json={})).status_code == 403
    assert (await client.patch(f"{API}/etl-runs/e1", headers=outsider, json={})).status_code == 403
    assert (await client.get(f"{API}/dq-rule-sets/r1", headers=outsider)).status_code == 200


async def test_writing_sql_run_on_the_database_asks_the_right_to_read_it(client, world):
    outsider, editor = world["outsider"], world["editor"]
    check = {"ruleSetId": "r1", "name": "n", "category": "plausibility", "severity": "warning",
             "sql": "SELECT 1 AS violated_rows, 1 AS total_rows"}
    file = {"pipelineId": "p1", "name": "a.sql", "content": "SELECT 1"}

    assert (await client.post(f"{API}/dq-custom-checks", headers=outsider, json={**check, "id": "c1"})).status_code == 403
    assert (await client.post(f"{API}/dq-rule-sets/r1/checks", headers=outsider, json=[{**check, "id": "c2"}])).status_code == 403
    assert (await client.put(f"{API}/dq-rule-sets/r1/checks", headers=outsider, json=[{**check, "id": "c3"}])).status_code == 403
    assert (await client.post(f"{API}/etl-files", headers=outsider, json={**file, "id": "f1"})).status_code == 403

    r = await client.post(f"{API}/dq-custom-checks", headers=editor, json={**check, "id": "c4"})
    assert r.status_code == 201, r.text
    r = await client.post(f"{API}/etl-files", headers=editor, json={**file, "id": "f2"})
    assert r.status_code == 201, r.text
    assert (await client.patch(f"{API}/dq-custom-checks/c4", headers=outsider, json={"sql": "SELECT 2"})).status_code == 403
    assert (await client.patch(f"{API}/dq-rule-sets/r1/checks", headers=outsider,
                               json=[{"id": "c4", "sql": "SELECT 2"}])).status_code == 403
    assert (await client.patch(f"{API}/etl-files/f2", headers=outsider, json={"content": "SELECT 2"})).status_code == 403
    assert (await client.patch(f"{API}/dq-custom-checks/c4", headers=outsider, json={"disabled": True})).status_code == 200
    assert (await client.patch(f"{API}/etl-files/f2", headers=outsider, json={"order": 3})).status_code == 200


async def test_a_stored_run_keeps_no_row_value_from_a_driver_error(client, world):
    admin = world["admin"]
    created = await client.post(f"{API}/dq-run-history", headers=admin, json=_dq_run("d1", world["source"]))
    assert created.status_code == 201, created.text
    patched = await client.patch(f"{API}/dq-run-history/d1", headers=admin, json={"report": _dq_run("d1", world["source"])["report"]})
    assert patched.status_code == 200, patched.text
    assert (await client.post(f"{API}/etl-runs", headers=admin, json=_etl_run("e1"))).status_code == 201
    assert (await client.patch(f"{API}/etl-runs/e1", headers=admin, json={"scripts": _etl_run("e1")["scripts"]})).status_code == 200

    dq = (await client.get(f"{API}/dq-rule-sets/r1/runs", headers=admin)).json()
    etl = (await client.get(f"{API}/etl-pipelines/p1/runs", headers=admin)).json()
    stored = str(dq) + str(etl)
    assert ROW_VALUE not in stored
    assert "Could not convert string" in dq[0]["report"]["results"][0]["errorMessage"]
    assert "Could not convert string" in etl[0]["scripts"][0]["error"]
