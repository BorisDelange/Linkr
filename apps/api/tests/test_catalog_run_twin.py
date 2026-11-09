"""A data catalog computation compiled by the client and run here stores the
cache the browser's own run stores over the same data (the fixture is written by
apps/web src/lib/duckdb/catalog-run-spec.twin.test.ts): the same SQL filled, the
same units planned from the same rows, the same cache — whole, resumed from a
cache the browser paused, and paused then resumed here."""

import asyncio
import json
from pathlib import Path

import duckdb
import pytest

from app.schemas.catalog_run import CatalogRunSpec
from app.services.server_runs.catalog import compute
from tests.test_concept_stats_cache import _admin_headers, _workspace

API = "/api/v1"
_FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "web" / "src" / "lib" / "__fixtures__" / "catalog-runs" / "run-spec.json"
)
TWIN = json.loads(_FIXTURE.read_text(encoding="utf-8"))
_VOLATILE = ("catalogId", "computedAt", "durationMs")


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


def _same(got: dict, expected: dict, *, any_row_order: bool = False) -> None:
    """`any_row_order`: the concepts and the cells in any order — an aggregate
    without ORDER BY returns its groups as its engine's threads finish them."""

    def strip(c: dict) -> dict:
        c = {k: v for k, v in c.items() if k not in _VOLATILE}
        if any_row_order:
            c["concepts"] = sorted(c["concepts"], key=lambda r: (str(r.get("dictionaryKey")), str(r["conceptId"])))
            c["crossings"] = [{**x, "rows": sorted(x["rows"], key=lambda r: r["values"])} for x in c["crossings"]]
        return c

    mismatches = list(_differences(strip(got), strip(expected)))
    assert not mismatches, "\n".join(mismatches[:40])


# --- the planning, from the browser's rows ------------------------------------


@pytest.mark.parametrize("case", range(len(TWIN["fills"])))
def test_the_tokens_are_filled_as_the_browser_fills_them(case):
    entry = TWIN["fills"][case]
    assert compute.fill_catalog_sql(entry["sql"], entry["fill"]) == entry["out"]


def _replay(st: compute.RunState | None, offset: int) -> dict:
    """The run planned from the browser's rows, each query checked against the
    one the browser sent at that point."""
    spec = CatalogRunSpec.model_validate(TWIN["spec"])
    queries = iter(TWIN["queries"])

    def query(sql: str) -> list[dict]:
        ran = next(queries)
        assert sql == ran["sql"]
        return ran["rows"]

    if st is None:
        rows = query(spec.size_sql)
        wanted = compute.slices_wanted(rows, spec.slice_rows, spec.max_slices)
        assert wanted >= 2
        st = compute.RunState(slices=compute.slices_from_bounds(query(compute.fill_catalog_sql(spec.bounds_sql, {"slices": wanted}))))
    else:
        for _ in range(2):
            next(queries)
    base = compute.base_units(spec, st.slices)
    plan = None
    at = 0
    for unit in base:
        sql = unit.sql
        rows = query(sql) if sql else []
        if at >= offset:
            unit.apply(st, rows)
        at += 1
    plan = compute.plan_crossings(spec, st)
    for unit in plan.units:
        rows = query(unit.sql) if unit.sql else []
        if at >= offset:
            unit.apply(st, rows)
        at += 1
    assert next(queries, None) is None
    cache = compute.cache_from_state({"catalogId": "twin-catalog", "labels": plan.labels}, st, plan.crossings, at)
    cache["modalities"] = compute.order_modalities(spec.modalities, cache["crossings"])
    del cache["work"]
    return cache


def test_planned_from_the_rows_as_the_browser_planned():
    _same(_replay(None, 0), TWIN["cache"])


def test_resumed_from_the_cache_the_browser_paused():
    paused = TWIN["paused"]
    _same(_replay(compute.state_from_cache(paused), paused["completedSteps"]), TWIN["cache"])


def test_a_stored_state_hands_only_scalars_to_the_sql():
    good = TWIN["paused"]
    for work in (
        {**good["work"], "slices": "x"},
        {**good["work"], "slices": [{"lo": ["1"]}]},
        {**good["work"], "slices": [None]},
        {**good["work"], "services": [[["ICU"], 3]]},
        {**good["work"], "concepts": [["c", 1, "2"]]},
    ):
        with pytest.raises(ValueError):
            compute.state_from_cache({**good, "work": work})
    with pytest.raises(ValueError):
        compute.state_from_cache({**good, "completedSteps": -1})


# --- the run, on the server ---------------------------------------------------


async def _catalog(client, monkeypatch, tmp_path_factory) -> tuple[dict, str]:
    from app.config import settings

    # Not tmp_path: that is the tests' data dir, which a serverPath may never touch.
    server_dir = tmp_path_factory.mktemp("server")
    monkeypatch.setattr(settings, "fs_browse_roots", str(server_dir))
    folder = server_dir / "warehouse"
    folder.mkdir()
    con = duckdb.connect()
    for stmt in (s.strip() for s in TWIN["setup"].split(";")):
        if stmt:
            con.execute(stmt)
    for table in TWIN["tables"]:
        con.execute(f"COPY {table} TO '{folder / table}.parquet' (FORMAT parquet)")
    con.close()
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    r = await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "pq", "name": {"en": "PQ"}, "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "serverPath": str(folder)},
    })
    assert r.status_code == 201, r.text
    source = r.json()["id"]
    r = await client.post(f"{API}/data-catalogs", headers=headers, json={
        "id": "twin-catalog", "workspaceId": ws, "name": {"en": "Twin"}, "dataSourceId": source,
        "variables": {}, "crossings": [], "anonymization": {"threshold": 10, "mode": "replace"},
    })
    assert r.status_code == 201, r.text
    return headers, r.json()["id"]


async def _until(client, headers, catalog, statuses, timeout=120.0) -> dict:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        run = (await client.get(f"{API}/server-runs/latest?kind=catalog&scopeId={catalog}", headers=headers)).json()
        if run and run["status"] in statuses:
            return run
        assert asyncio.get_running_loop().time() < deadline, run
        await asyncio.sleep(0.1)


async def _stored(client, headers, catalog) -> tuple[dict, dict]:
    wire = (await client.get(f"{API}/data-catalogs/{catalog}/results-cache", headers=headers)).json()
    row = (await client.get(f"{API}/data-catalogs/{catalog}", headers=headers)).json()
    return {**wire["payload"], "computedAt": wire["computedAt"]}, row


async def test_the_server_stores_what_the_browser_stores(client, monkeypatch, tmp_path_factory):
    headers, catalog = await _catalog(client, monkeypatch, tmp_path_factory)
    r = await client.post(f"{API}/server-runs", headers=headers, json={"kind": "catalog", "scopeId": catalog, "spec": TWIN["spec"]})
    assert r.status_code == 202, r.text
    run = await _until(client, headers, catalog, {"done", "failed"})
    assert run["status"] == "done", run["error"]
    assert run["state"]["offset"] == run["state"]["total"] == len(TWIN["queries"]) - 2 + 1
    cache, row = await _stored(client, headers, catalog)
    _same(cache, TWIN["cache"], any_row_order=True)
    assert row["status"] == "success" and row["computedSteps"] is None and row["lastError"] is None
    assert row["lastComputedAt"] == cache["computedAt"] and row["lastComputeDurationMs"] == cache["durationMs"]


async def test_a_start_resumes_the_computation_the_page_paused(client, monkeypatch, tmp_path_factory):
    headers, catalog = await _catalog(client, monkeypatch, tmp_path_factory)
    paused = {k: v for k, v in TWIN["paused"].items() if k not in ("catalogId", "computedAt")}
    r = await client.put(f"{API}/data-catalogs/{catalog}/results-cache", headers=headers,
                         json={"computedAt": TWIN["paused"]["computedAt"], "payload": paused})
    assert r.status_code == 204, r.text
    r = await client.patch(f"{API}/data-catalogs/{catalog}", headers=headers, json={"computedSteps": paused["completedSteps"]})
    assert r.status_code == 200, r.text
    r = await client.post(f"{API}/server-runs", headers=headers,
                          json={"kind": "catalog", "scopeId": catalog, "spec": {**TWIN["spec"], "fresh": False}})
    assert r.status_code == 202, r.text
    run = await _until(client, headers, catalog, {"done", "failed"})
    assert run["status"] == "done", run["error"]
    cache, _ = await _stored(client, headers, catalog)
    _same(cache, TWIN["cache"], any_row_order=True)


async def test_paused_then_resumed_where_it_stopped(client, monkeypatch, tmp_path_factory):
    from app.services.server_runs.catalog.executor import CatalogExecutor

    # Slowed down, so a pause lands among the crossings.
    query = CatalogExecutor.query

    async def slow(self, sql, what, **kwargs):
        await asyncio.sleep(0.05)
        return await query(self, sql, what, **kwargs)

    monkeypatch.setattr(CatalogExecutor, "query", slow)
    headers, catalog = await _catalog(client, monkeypatch, tmp_path_factory)
    url = f"{API}/server-runs"
    run = (await client.post(url, headers=headers, json={"kind": "catalog", "scopeId": catalog, "spec": TWIN["spec"]})).json()
    deadline = asyncio.get_running_loop().time() + 60
    while (await _until(client, headers, catalog, {"running", "done"}))["state"].get("total") is None:
        assert asyncio.get_running_loop().time() < deadline
        await asyncio.sleep(0.02)
    r = await client.post(f"{url}/{run['id']}/pause", headers=headers)
    assert r.json()["status"] in ("pausing", "paused")
    paused = await _until(client, headers, catalog, {"paused"})
    at = paused["state"]["offset"]
    assert 0 < at < paused["state"]["total"]
    cache, row = await _stored(client, headers, catalog)
    assert cache["completedSteps"] == row["computedSteps"] == at and cache["work"]["slices"]

    resumed = (await client.post(f"{url}/{run['id']}/resume", headers=headers)).json()
    assert resumed["id"] == run["id"]
    done = await _until(client, headers, catalog, {"done", "failed"})
    assert done["status"] == "done", done["error"]
    assert done["attempt"] == 2
    cache, row = await _stored(client, headers, catalog)
    _same(cache, TWIN["cache"], any_row_order=True)
    assert row["computedSteps"] is None


async def test_a_start_checks_its_catalog_and_spec(client, monkeypatch, tmp_path_factory):
    headers, catalog = await _catalog(client, monkeypatch, tmp_path_factory)
    r = await client.post(f"{API}/server-runs", headers=headers, json={"kind": "catalog", "scopeId": "no-such-catalog", "spec": TWIN["spec"]})
    assert r.status_code == 404
    r = await client.post(f"{API}/server-runs", headers=headers, json={"kind": "catalog", "scopeId": catalog, "spec": {**TWIN["spec"], "maxSlices": 1000}})
    assert r.status_code == 422


# --- the size estimate ---------------------------------------------------------

ESTIMATE = TWIN["estimate"]


def test_estimated_from_the_rows_as_the_browser_estimated():
    spec = CatalogRunSpec.model_validate(ESTIMATE["spec"])
    queries = iter(ESTIMATE["queries"])

    def query(sql: str) -> list[dict]:
        ran = next(queries)
        assert sql == ran["sql"]
        return ran["rows"]

    st = compute.RunState()
    for unit in compute.estimate_ranking_units(spec):
        unit.apply(st, query(unit.sql))
    fill = compute.plan_crossings(spec, st).fill
    got = {e.key: compute.estimate_of_rows(query(compute.fill_catalog_sql(e.sql, fill))) for e in spec.estimates}
    assert next(queries, None) is None
    assert got == ESTIMATE["estimates"]


async def _estimates(client, headers, catalog) -> dict:
    r = await client.get(f"{API}/data-catalogs/{catalog}/estimates", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


async def _estimate_until(client, headers, catalog, statuses, timeout=120.0) -> dict:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        run = (await client.get(f"{API}/server-runs/latest?kind=catalog_estimate&scopeId={catalog}", headers=headers)).json()
        if run and run["status"] in statuses:
            return run
        assert asyncio.get_running_loop().time() < deadline, run
        await asyncio.sleep(0.1)


async def test_the_server_estimates_what_the_browser_estimates(client, monkeypatch, tmp_path_factory):
    headers, catalog = await _catalog(client, monkeypatch, tmp_path_factory)
    assert await _estimates(client, headers, catalog) == {}
    r = await client.post(f"{API}/server-runs", headers=headers, json={"kind": "catalog_estimate", "scopeId": catalog, "spec": ESTIMATE["spec"]})
    assert r.status_code == 202, r.text
    run = await _estimate_until(client, headers, catalog, {"done", "failed"})
    assert run["status"] == "done", run["error"]
    assert run["state"]["offset"] == run["state"]["total"] == len(ESTIMATE["queries"])
    assert await _estimates(client, headers, catalog) == ESTIMATE["estimates"]
    # Nothing of the catalog's results is written.
    assert (await client.get(f"{API}/data-catalogs/{catalog}/results-cache", headers=headers)).json() is None
    row = (await client.get(f"{API}/data-catalogs/{catalog}", headers=headers)).json()
    assert row["status"] == "draft" and row["computedSteps"] is None
    # They go with the catalog, and its runs with them.
    assert (await client.delete(f"{API}/data-catalogs/{catalog}", headers=headers)).status_code == 204
    from app.core import database
    from app.services import stats_cache_service
    async with database.async_session() as db:
        assert await stats_cache_service.get(db, "catalog-estimate", catalog) is None


async def test_an_estimate_paused_then_resumed_lands_every_estimate_once(client, monkeypatch, tmp_path_factory):
    from app.services.server_runs.catalog.executor import CatalogExecutor

    query = CatalogExecutor.query

    async def slow(self, sql, what, **kwargs):
        await asyncio.sleep(0.05)
        return await query(self, sql, what, **kwargs)

    monkeypatch.setattr(CatalogExecutor, "query", slow)
    headers, catalog = await _catalog(client, monkeypatch, tmp_path_factory)
    url = f"{API}/server-runs"
    run = (await client.post(url, headers=headers, json={"kind": "catalog_estimate", "scopeId": catalog, "spec": ESTIMATE["spec"]})).json()
    deadline = asyncio.get_running_loop().time() + 60
    while (await _estimate_until(client, headers, catalog, {"running", "done"}))["state"].get("next", 0) < 2:
        assert asyncio.get_running_loop().time() < deadline
        await asyncio.sleep(0.02)
    await client.post(f"{url}/{run['id']}/pause", headers=headers)
    paused = await _estimate_until(client, headers, catalog, {"paused"})
    at = paused["state"]["next"]
    assert 0 < at < len(ESTIMATE["spec"]["estimates"])
    # What it estimated so far is there already, the page reads it as it lands.
    assert len(await _estimates(client, headers, catalog)) == at

    resumed = (await client.post(f"{url}/{run['id']}/resume", headers=headers)).json()
    assert resumed["id"] == run["id"]
    done = await _estimate_until(client, headers, catalog, {"done", "failed"})
    assert done["status"] == "done", done["error"]
    assert await _estimates(client, headers, catalog) == ESTIMATE["estimates"]


async def test_a_kind_runs_only_its_mode(client, monkeypatch, tmp_path_factory):
    headers, catalog = await _catalog(client, monkeypatch, tmp_path_factory)
    url = f"{API}/server-runs"
    r = await client.post(url, headers=headers, json={"kind": "catalog", "scopeId": catalog, "spec": ESTIMATE["spec"]})
    assert r.status_code == 400
    r = await client.post(url, headers=headers, json={"kind": "catalog_estimate", "scopeId": catalog, "spec": TWIN["spec"]})
    assert r.status_code == 400
