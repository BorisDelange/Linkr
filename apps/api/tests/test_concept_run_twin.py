"""A concept run compiled by the client and run here stores the profiles the
browser's own run stores over the same data (the fixture is written by
apps/web src/lib/concept-mapping/run-spec.twin.test.ts). And the run is the
server's: started once whatever the starts, paused, resumed where it stopped."""

import asyncio
import json
from pathlib import Path

import duckdb
import pytest

from app.core import database
from app.services import concept_profile_service
from tests.test_concept_stats_cache import _admin_headers, _workspace

API = "/api/v1"
_FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "web" / "src" / "lib" / "__fixtures__" / "concept-runs" / "run-spec.json"
)
TWIN = json.loads(_FIXTURE.read_text(encoding="utf-8"))


# Some warehouses store their concept ids as DOUBLE (a CSV import that saw a
# blank): the run reads them as the browser does, through Number().
_IDS_AS_DOUBLE = (
    "ALTER TABLE concept ALTER concept_id TYPE DOUBLE",
    "ALTER TABLE measurement ALTER mc TYPE DOUBLE",
    "ALTER TABLE measurement ALTER msc TYPE DOUBLE",
)


async def _parquet_source(client, monkeypatch, tmp_path_factory, ids_as_double=False) -> tuple[dict, str]:
    from app.config import settings

    # Not tmp_path: that is the tests' data dir, which a serverPath may never touch.
    server_dir = tmp_path_factory.mktemp("server")
    monkeypatch.setattr(settings, "fs_browse_roots", str(server_dir))
    folder = server_dir / "omop"
    folder.mkdir()
    con = duckdb.connect()
    for stmt in (s.strip() for s in TWIN["setup"].split(";")):
        if stmt:
            con.execute(stmt)
    for stmt in _IDS_AS_DOUBLE if ids_as_double else ():
        con.execute(stmt)
    for table in ("concept", "measurement", "person"):
        con.execute(f"COPY {table} TO '{folder / table}.parquet' (FORMAT parquet)")
    con.close()
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    r = await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "pq", "name": {"en": "PQ"}, "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "serverPath": str(folder)},
    })
    assert r.status_code == 201, r.text
    return headers, r.json()["id"]


def _differences(a, b, path=""):
    """Where two JSON values differ; 50 and 50.0 are one number, as in JSON."""
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            yield from _differences(a.get(k, "<absent>"), b.get(k, "<absent>"), f"{path}.{k}")
    elif isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        for n, (x, y) in enumerate(zip(a, b, strict=True)):
            yield from _differences(x, y, f"{path}[{n}]")
    elif a != b:
        yield f"{path}: {a!r} != {b!r}"


async def _until(client, headers, source, statuses, timeout=120.0) -> dict:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        run = (await client.get(f"{API}/server-runs/latest?kind=stats&scopeId={source}", headers=headers)).json()
        if run and run["status"] in statuses:
            return run
        assert asyncio.get_running_loop().time() < deadline, run
        await asyncio.sleep(0.2)


@pytest.mark.parametrize("ids_as_double", [False, True])
async def test_the_server_stores_what_the_browser_stores(client, monkeypatch, tmp_path_factory, ids_as_double):
    headers, source = await _parquet_source(client, monkeypatch, tmp_path_factory, ids_as_double)
    r = await client.post(f"{API}/server-runs", headers=headers,
                          json={"kind": "stats", "scopeId": source, "spec": TWIN["spec"]})
    assert r.status_code == 202, r.text
    run = await _until(client, headers, source, {"done", "failed"})
    assert run["status"] == "done", run["error"]
    assert run["state"]["done"] == run["state"]["total"] == len(TWIN["expected"]), run["state"]

    ids = [p["conceptId"] for p in TWIN["expected"]]
    async with database.async_session() as db:
        stored = await concept_profile_service.read(db, source, "concept", ids)
    got = sorted(({**p, "computedAt": ""} for p in stored), key=lambda p: p["conceptId"])
    mismatches = list(_differences(got, TWIN["expected"]))
    assert not mismatches, "\n".join(mismatches[:40])


async def test_a_second_start_follows_the_first(client, monkeypatch, tmp_path_factory):
    headers, source = await _parquet_source(client, monkeypatch, tmp_path_factory)
    url = f"{API}/server-runs"
    first = (await client.post(url, headers=headers, json={"kind": "stats", "scopeId": source, "spec": TWIN["spec"]})).json()
    second = (await client.post(url, headers=headers, json={"kind": "stats", "scopeId": source, "spec": TWIN["spec"]})).json()
    assert second["id"] == first["id"]
    await _until(client, headers, source, {"done", "failed"})


@pytest.mark.parametrize("between", ["pages", "batches"])
async def test_paused_then_resumed_where_it_stopped(client, monkeypatch, tmp_path_factory, between):
    from app.services.server_runs.concepts import executor as loop

    # One concept a page, or one a batch in one page: a pause lands between
    # two pages, or in the middle of a page that a resume redoes.
    monkeypatch.setattr(loop, "PAGE_SIZE" if between == "pages" else "BATCH_CONCEPTS", 1)
    headers, source = await _parquet_source(client, monkeypatch, tmp_path_factory)
    url = f"{API}/server-runs"
    run = (await client.post(url, headers=headers, json={"kind": "stats", "scopeId": source, "spec": TWIN["spec"]})).json()
    deadline = asyncio.get_running_loop().time() + 60
    while (await _until(client, headers, source, {"running", "done"}))["state"].get("done", 0) < 2:
        assert asyncio.get_running_loop().time() < deadline
        await asyncio.sleep(0.05)
    r = await client.post(f"{url}/{run['id']}/pause", headers=headers)
    assert r.json()["status"] in ("pausing", "paused", "done")
    paused = await _until(client, headers, source, {"paused", "done"})
    if paused["status"] == "done":
        return
    at = paused["state"]["done"]
    assert 0 < at < paused["state"]["total"]
    # What the batches taught is kept for the resume.
    assert paused["state"]["learnt"]["watchdog"]["srtt"] > 0

    resumed = (await client.post(f"{url}/{run['id']}/resume", headers=headers)).json()
    assert resumed["id"] == run["id"] and resumed["state"]["done"] == at
    # Never back: the page a resume redoes counts from where it stood.
    while (seen := await _until(client, headers, source, {"queued", "running", "done", "failed"}))["status"] in ("queued", "running"):
        assert seen["state"]["done"] >= at, seen["state"]
        await asyncio.sleep(0.02)
    assert seen["status"] == "done", seen["error"]
    assert seen["attempt"] == 2 and seen["state"]["done"] == seen["state"]["total"]
    async with database.async_session() as db:
        stored = await concept_profile_service.read(db, source, "concept", [p["conceptId"] for p in TWIN["expected"]])
    got = sorted(({**p, "computedAt": ""} for p in stored), key=lambda p: p["conceptId"])
    mismatches = list(_differences(got, TWIN["expected"]))
    assert not mismatches, "\n".join(mismatches[:40])


@pytest.mark.parametrize("ids_as_double", [False, True])
async def test_an_extraction_writes_its_project_csv(client, monkeypatch, tmp_path_factory, ids_as_double):
    from app.services import blob_store

    headers, source = await _parquet_source(client, monkeypatch, tmp_path_factory, ids_as_double)
    ws = (await client.get(f"{API}/data-sources/{source}", headers=headers)).json()["workspaceId"]
    project = (await client.post(f"{API}/mapping-projects", headers=headers, json={
        "id": f"twin-extraction-{ids_as_double}".lower(), "workspaceId": ws, "name": {"en": "Twin"}, "sourceType": "database", "dataSourceId": source,
    })).json()
    spec = {**TWIN["spec"], "extraction": {
        "fileSourceData": {"fileName": "source-concepts.csv", "rows": [], "columns": ["concept_id"], "columnMapping": {}},
        "dictionaryKeys": ["concept"],
    }}
    r = await client.post(f"{API}/server-runs", headers=headers,
                          json={"kind": "extraction", "scopeId": project["id"], "spec": spec})
    assert r.status_code == 202, r.text
    while True:
        run = (await client.get(
            f"{API}/server-runs/latest?kind=extraction&scopeId={project['id']}", headers=headers,
        )).json()
        if run["status"] in ("done", "failed"):
            break
        await asyncio.sleep(0.2)
    assert run["status"] == "done", run["error"]

    stored = (await client.get(f"{API}/mapping-projects/{project['id']}", headers=headers)).json()
    assert stored["sourceExtraction"]["extracted"] == stored["sourceExtraction"]["total"] == len(TWIN["expected"])
    assert stored["fileSourceData"]["totalRowCount"] == len(TWIN["expected"])
    lines = (await blob_store.read_bytes(stored["rawFileSha"])).decode().splitlines()
    assert lines[0].startswith("terminology,") and len(lines) == 1 + len(TWIN["expected"])
    # The statistics went to the database's profiles too, for its Concepts tab.
    async with database.async_session() as db:
        assert len(await concept_profile_service.read(db, source, "concept", [p["conceptId"] for p in TWIN["expected"]])) == len(TWIN["expected"])


@pytest.mark.parametrize("ids_as_double", [False, True])
async def test_the_counts_come_first_then_the_statistics(client, monkeypatch, tmp_path_factory, ids_as_double):
    headers, source = await _parquet_source(client, monkeypatch, tmp_path_factory, ids_as_double)
    base = f"{API}/data-sources/{source}/concept-cache"
    # The page stores the manifest before it starts the run (`prepareCountSpec`).
    r = await client.put(f"{base}/run", headers=headers, json={"manifest": TWIN["countsManifest"], "reset": True})
    assert r.status_code == 204, r.text
    r = await client.post(f"{API}/server-runs", headers=headers,
                          json={"kind": "stats", "scopeId": source, "spec": {**TWIN["spec"], "counts": TWIN["counts"]}})
    assert r.status_code == 202, r.text
    assert r.json()["state"]["stage"] == "counts"
    run = await _until(client, headers, source, {"done", "failed"})
    assert run["status"] == "done", run["error"]
    assert run["state"]["counts"] == {"records": {"done": 2, "total": 2}, "patients": {"done": 1, "total": 1}}
    assert run["state"]["assembled"] >= 2
    assert "etaSeconds" not in run["state"]

    # The job says what the run computed, step by step, and what it ran last.
    job = (await client.get(f"{API}/jobs/{run['jobId']}?withInput=true", headers=headers)).json()
    log = job["logTail"]
    assert "Counting the records of each concept: 2 queries" in log and "Assembling the counts" in log, log
    assert f"{len(TWIN['expected'])} concepts to profile, by records" in log, log
    assert "Statistics of " in log and log.splitlines()[-1].endswith("Done"), log
    assert job["input"].startswith("-- Statistics of "), job["input"][:200]

    status = (await client.get(base, headers=headers)).json()
    assert sorted(status["run"]["doneUnits"]) == sorted(u["key"] for u in TWIN["countsManifest"]["units"])
    assert status["run"]["manifest"]["finishedAt"]
    rows = (await client.post(f"{base}/query", headers=headers, json={
        "sql": "SELECT concept_id, record_count, patient_count FROM concepts ORDER BY concept_id",
    })).json()["rows"]
    counted = {int(r["concept_id"]): (r["record_count"], r["patient_count"]) for r in rows}
    # The statistics count what the concept list counts.
    for p in TWIN["expected"]:
        if p["conceptId"] in counted:
            assert counted[p["conceptId"]] == (p["rowsCount"], p["patientsCount"]), p["conceptId"]
    assert counted[12] in ((None, None), (0, 0))


@pytest.mark.parametrize("trouble", ["timed out", "stalled"])
async def test_a_slow_batch_is_cut_at_once_and_caps_the_next_ones(client, monkeypatch, tmp_path_factory, trouble):
    """A database whose batches turn slow, or hang (duckdb#26720), past a few
    ids: the run stops paying for it at every batch, and still stores what the
    browser stores."""
    import re

    from app.services.server_runs.concepts import executor as loop
    from app.services.server_runs.worker import QueryStalled, QueryTimedOut

    query = loop.ConceptExecutor._query

    async def cliff(self, sql, what, **kw):
        sized = re.match(r"Statistics of (\d+) concepts", what)
        if kw.get("batch") and sized and int(sized.group(1)) > 3:
            raise QueryTimedOut(30) if trouble == "timed out" else QueryStalled(30)
        return await query(self, sql, what, **kw)

    monkeypatch.setattr(loop.ConceptExecutor, "_query", cliff)
    headers, source = await _parquet_source(client, monkeypatch, tmp_path_factory)
    await client.post(f"{API}/server-runs", headers=headers, json={"kind": "stats", "scopeId": source, "spec": TWIN["spec"]})
    run = await _until(client, headers, source, {"done", "failed"})
    assert run["status"] == "done", run["error"]
    assert run["state"].get("failedCount", 0) == 0

    log = (await client.get(f"{API}/jobs/{run['jobId']}", headers=headers)).json()["logTail"]
    assert "batches of up to 3 concepts from now on" in log, log
    assert ("stopped working" if trouble == "stalled" else "ran past its deadline") in log, log
    assert "tried again" not in log, log
    assert run["state"]["learnt"]["batchCap"] == 3
    # Never grown back to a size that failed.
    assert 3 < run["state"]["learnt"]["batchCeiling"] <= 12
    async with database.async_session() as db:
        stored = await concept_profile_service.read(db, source, "concept", [p["conceptId"] for p in TWIN["expected"]])
    got = sorted(({**p, "computedAt": ""} for p in stored), key=lambda p: p["conceptId"])
    mismatches = list(_differences(got, TWIN["expected"]))
    assert not mismatches, "\n".join(mismatches[:40])
