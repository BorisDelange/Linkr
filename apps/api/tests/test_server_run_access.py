"""Who may read, stop and resume a server run (routes/server_runs.py): what its
scope allows, its database's rows only to who may read the database, and a
resume only to the user who started it, whose login its queries use."""

import asyncio

import pytest

from app.services.execution import jobs
from tests.test_etl_jobs import _admin, _target
from tests.test_server_folder_reach import _member
from tests.test_server_run_etl import SLOW, _pipeline
from tests.test_server_run_etl import _spec as _etl_spec
from tests.test_server_run_query_list import _spec, _until

API = "/api/v1"
READER = ["etl:read", "databases:read"]


async def _run(client, headers, pid, *items) -> dict:
    r = await client.post(f"{API}/server-runs", headers=headers, json={"kind": "etl_quality", "scopeId": pid, "spec": _spec(*items)})
    assert r.status_code == 202, r.text
    return r.json()


@pytest.fixture
async def world(client, db, seed_roles):
    admin = await _admin(client)
    ws, ds = await _target(client, admin)
    other_ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "Other"}})).json()["id"]
    return {
        "admin": admin, "ws": ws, "ds": ds, "pid": await _pipeline(client, admin, ws, ds),
        "outsider": await _member(client, db, other_ws, "outsider", READER),
        "reader": await _member(client, db, ws, "reader", READER),
        "db_writer": await _member(client, db, ws, "db-writer", [*READER, "databases:write"]),
        "cohort_reader": await _member(client, db, ws, "cohort-reader", ["cohorts:read", "etl:read"]),
    }


async def test_a_member_of_another_workspace_reaches_none_of_a_run(client, world):
    admin, pid, outsider = world["admin"], world["pid"], world["outsider"]
    run = await _run(client, admin, pid, ("a", "SELECT 1 AS x"))
    await _until(client, admin, pid, {"done"})
    url = f"{API}/server-runs/{run['id']}"
    assert (await client.get(f"{API}/server-runs/latest?kind=etl_quality&scopeId={pid}", headers=outsider)).status_code == 403
    assert (await client.get(f"{url}/results/a", headers=outsider)).status_code == 403
    for action in ("pause", "cancel", "resume"):
        assert (await client.post(f"{url}/{action}", headers=outsider)).status_code == 403, action
    # Its members do.
    assert (await client.get(f"{url}/results/a", headers=world["reader"])).json() == {"rows": [{"x": 1}]}


async def test_only_its_starter_resumes_a_run(client, world):
    admin, pid, reader = world["admin"], world["pid"], world["reader"]
    run = await _run(client, admin, pid, ("slow", SLOW.removesuffix(";")))
    await _until(client, admin, pid, {"running"})
    # Stopping it is its scope's business.
    assert (await client.post(f"{API}/server-runs/{run['id']}/pause", headers=reader)).status_code == 200
    await _until(client, admin, pid, {"paused"})
    r = await client.post(f"{API}/server-runs/{run['id']}/resume", headers=reader)
    assert r.status_code == 403 and "started" in r.json()["detail"]
    assert (await client.post(f"{API}/server-runs/{run['id']}/cancel", headers=admin)).json()["status"] == "cancelled"


async def test_a_pipeline_run_is_stopped_by_the_pipeline_writers_alone(client, world):
    admin, ds, pid = world["admin"], world["ds"], world["pid"]
    run = (await client.post(f"{API}/server-runs", headers=admin, json={"kind": "etl", "scopeId": ds, "spec": _etl_spec(pid, SLOW)})).json()
    # Writing the target is not enough: the pipeline is the ETL writers'.
    for action in ("pause", "cancel", "resume"):
        assert (await client.post(f"{API}/server-runs/{run['id']}/{action}", headers=world["db_writer"])).status_code == 403
    await client.post(f"{API}/server-runs/{run['id']}/cancel", headers=admin)
    deadline = asyncio.get_running_loop().time() + 30
    while (await client.get(f"{API}/server-runs/latest?kind=etl&scopeId={ds}", headers=admin)).json()["status"] != "cancelled":
        assert asyncio.get_running_loop().time() < deadline
        await asyncio.sleep(0.1)


async def test_a_run_whose_job_cannot_be_made_fails_at_once(client, world, monkeypatch):
    async def refused(*args, **kwargs):
        raise ValueError("no job here")

    create = jobs.create
    monkeypatch.setattr(jobs, "create", refused)
    admin, pid = world["admin"], world["pid"]
    r = await client.post(f"{API}/server-runs", headers=admin, json={"kind": "etl_quality", "scopeId": pid, "spec": _spec(("a", "SELECT 1"))})
    assert r.status_code == 422
    run = (await client.get(f"{API}/server-runs/latest?kind=etl_quality&scopeId={pid}", headers=admin)).json()
    assert run["status"] == "failed" and "no job here" in run["error"]
    # And it does not hold the scope.
    monkeypatch.setattr(jobs, "create", create)
    await _run(client, admin, pid, ("a", "SELECT 1"))
    assert (await _until(client, admin, pid, {"done", "failed"}))["status"] == "done"


async def test_a_size_estimate_is_started_by_the_catalog_writers(client, db, world):
    admin, ws, ds = world["admin"], world["ws"], world["ds"]
    r = await client.post(f"{API}/data-catalogs", headers=admin, json={
        "id": "estimated", "workspaceId": ws, "name": {"en": "C"}, "dataSourceId": ds,
        "variables": {}, "crossings": [], "anonymization": {"threshold": 10, "mode": "replace"},
    })
    assert r.status_code == 201, r.text
    reader = await _member(client, db, ws, "catalog-reader", ["catalog:read", "databases:read"])
    r = await client.post(f"{API}/server-runs", headers=reader, json={
        "kind": "catalog_estimate", "scopeId": "estimated", "spec": {"mode": "estimate"},
    })
    assert r.status_code == 403


async def test_an_extraction_neither_counts_nor_starts_the_database_over(client, world):
    from tests.test_concept_run_twin import TWIN

    admin, ws, ds = world["admin"], world["ws"], world["ds"]
    project = (await client.post(f"{API}/mapping-projects", headers=admin, json={
        "id": "extraction-checks", "workspaceId": ws, "name": {"en": "M"}, "sourceType": "database", "dataSourceId": ds,
    })).json()
    extraction = {"fileSourceData": {"fileName": "source-concepts.csv", "rows": []}, "dictionaryKeys": ["concept"]}
    for extra in ({"fresh": True}, {"counts": TWIN["counts"]}):
        r = await client.post(f"{API}/server-runs", headers=admin, json={
            "kind": "extraction", "scopeId": project["id"], "spec": {**TWIN["spec"], "extraction": extraction, **extra},
        })
        assert r.status_code == 400, (extra.keys(), r.text)


async def test_a_spec_without_the_options_the_profiles_read_is_refused(client, world):
    from tests.test_concept_run_twin import TWIN

    admin, ds = world["admin"], world["ds"]
    options = {k: v for k, v in TWIN["spec"]["options"].items() if k != "topN"}
    r = await client.post(f"{API}/server-runs", headers=admin, json={
        "kind": "stats", "scopeId": ds, "spec": {**TWIN["spec"], "options": options},
    })
    assert r.status_code == 422 and "topN" in r.text


async def test_a_cohort_runs_rows_are_for_who_may_read_its_database(client, db, world):
    from app.services.server_runs import executor, query_list, state

    admin, ws, ds = world["admin"], world["ws"], world["ds"]
    uid = (await client.post(f"{API}/projects", headers=admin, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]
    r = await client.post(f"{API}/cohorts", headers=admin, json={
        "id": "members", "projectUid": uid, "name": "Adults", "level": "patient",
        "criteriaTree": {"type": "group", "op": "and", "children": []},
    })
    assert r.status_code in (200, 201), r.text
    run, _ = await state.create(
        db, kind="cohort_run", scope_id="members", data_source_id=ds, workspace_id=ws, user_id=1,
        spec={}, initial={},
    )
    executor.write_json(query_list.result_path(run.id, "members"), [{"person_id": 1}])
    url = f"{API}/server-runs/{run.id}/results/members"
    assert (await client.get(url, headers=admin)).json() == {"rows": [{"person_id": 1}]}
    # A reader of the cohort, who sees the run…
    latest = f"{API}/server-runs/latest?kind=cohort_run&scopeId=members"
    assert (await client.get(latest, headers=world["cohort_reader"])).json()["id"] == run.id
    # …but not its rows, the database's.
    assert (await client.get(url, headers=world["cohort_reader"])).status_code == 403


@pytest.mark.parametrize("deleted", ["database", "pipeline", "workspace"])
async def test_deleting_what_a_run_reads_stops_it_and_drops_its_files(client, db, world, deleted):
    from app.models.server_run import ServerRun
    from app.services.server_runs import executor

    admin, ws, ds, pid = world["admin"], world["ws"], world["ds"], world["pid"]
    run = await _run(client, admin, pid, ("first", "SELECT 1 AS x"), ("slow", SLOW.removesuffix(";")))
    await _until(client, admin, pid, {"running"})
    while not executor.run_dir(run["id"]).exists():
        await asyncio.sleep(0.05)
    url = {"database": f"/data-sources/{ds}", "pipeline": f"/etl-pipelines/{pid}", "workspace": f"/workspaces/{ws}"}[deleted]
    r = await client.delete(f"{API}{url}", headers=admin)
    assert r.status_code in (200, 204), r.text
    assert not executor.is_running(run["id"])
    assert not executor.run_dir(run["id"]).exists()
    assert await db.get(ServerRun, run["id"]) is None
