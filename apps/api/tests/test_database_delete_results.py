"""Removing a database removes what was computed from it in its workspace, and a
database created later under the same id starts with nothing of it."""

import pytest
from sqlalchemy import select

from app.models.cohort import Cohort
from app.models.data_catalog import DataCatalog
from app.models.dq_rule_set import DqRuleSet, DqRunHistory
from app.models.etl_pipeline import EtlPipeline
from app.models.project import Project
from app.models.stats_cache import StatsCache
from app.models.workspace import Workspace
from tests.test_cohort_derive_routes import API, _admin

DB_ID = "22222222-2222-4222-8222-222222222222"


async def _create(client, headers, ws: str, alias: str = "first"):
    r = await client.post(f"{API}/data-sources", headers=headers, json={
        "id": DB_ID, "workspaceId": ws, "alias": alias, "name": {"en": alias}, "sourceType": "database",
        "connectionConfig": {"engine": "duckdb"},
    })
    assert r.status_code == 201, r.text


async def _computed_from(db, ws: str, suffix: str) -> None:
    db.add(Project(uid=f"p-{suffix}", workspace_id=ws, name={"en": "p"},
                   linked_data_source_ids=["other-db", DB_ID], linked_data_source_refs=[{"entityId": "o"}, {"entityId": "d"}]))
    await db.flush()
    db.add(Cohort(id=f"k-{suffix}", project_uid=f"p-{suffix}", data_source_id=DB_ID, name={"en": "k"}, level="patient",
                  materialization={"patientIds": ["4242"], "count": 1}, result_count=1, attrition=[{"n": 1}]))
    db.add(DqRuleSet(id=f"rs-{suffix}", workspace_id=ws, data_source_id=DB_ID, name={"en": "r"}, last_score=0.9,
                     last_run_at="2026-01-01T00:00:00Z"))
    await db.flush()
    db.add(DqRunHistory(id=f"run-{suffix}", rule_set_id=f"rs-{suffix}", workspace_id=ws, data_source_id=DB_ID,
                        started_at="2026-01-01T00:00:00Z", status="done", report={"n": 1}))
    db.add(DataCatalog(id=f"cat-{suffix}", workspace_id=ws, data_source_id=DB_ID, name={"en": "c"},
                       last_computed_at="2026-01-01T00:00:00Z"))
    db.add(EtlPipeline(id=f"etl-{suffix}", workspace_id=ws, target_data_source_id=DB_ID, name={"en": "e"}))
    db.add(StatsCache(scope="catalog", cache_key=f"cat-{suffix}", computed_at="x", payload={"n": 1}))
    db.add(StatsCache(scope="etl-quality", cache_key=f"etl-{suffix}", computed_at="x", payload={"n": 1}))
    await db.commit()


async def _state(db, suffix: str) -> dict:
    db.expire_all()
    cohort = await db.get(Cohort, f"k-{suffix}")
    project = await db.get(Project, f"p-{suffix}")
    rule_set = await db.get(DqRuleSet, f"rs-{suffix}")
    caches = (await db.execute(select(StatsCache.cache_key).where(
        StatsCache.cache_key.in_([f"cat-{suffix}", f"etl-{suffix}"])))).scalars().all()
    return {
        "frozen": cohort.materialization, "count": cohort.result_count, "attrition": cohort.attrition,
        "cohort_db": cohort.data_source_id,
        "linked": project.linked_data_source_ids, "refs": project.linked_data_source_refs,
        "run": await db.get(DqRunHistory, f"run-{suffix}") is not None,
        "score": rule_set.last_score, "rule_set_db": rule_set.data_source_id,
        "catalog_computed": (await db.get(DataCatalog, f"cat-{suffix}")).last_computed_at,
        "caches": sorted(caches),
    }


CLEARED = {
    "frozen": None, "count": None, "attrition": None, "cohort_db": DB_ID,
    "linked": ["other-db"], "refs": [{"entityId": "o"}],
    "run": False, "score": None, "rule_set_db": DB_ID, "catalog_computed": None, "caches": [],
}


@pytest.mark.parametrize("delete_data", [False, True])
async def test_removing_a_database_removes_what_was_computed_from_it(client, db, delete_data):
    admin = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "A"}})).json()["id"]
    await _create(client, admin, ws)
    await _computed_from(db, ws, "a")

    r = await client.delete(f"{API}/data-sources/{DB_ID}", headers=admin, params={"deleteData": delete_data})
    assert r.status_code == 204
    assert await _state(db, "a") == CLEARED

    await _computed_from(db, ws, "b")
    await _create(client, admin, ws, "second")
    assert {k: v for k, v in (await _state(db, "b")).items() if k not in ("linked", "refs")} == {
        k: v for k, v in CLEARED.items() if k not in ("linked", "refs")
    }


async def test_another_workspace_s_results_survive_a_database_of_the_same_id(client, db):
    admin = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "A"}})).json()["id"]
    db.add(Workspace(id="ws-other", name={"en": "other"}))
    await db.commit()
    await _computed_from(db, "ws-other", "o")
    before = await _state(db, "o")

    await _create(client, admin, ws)
    assert (await client.delete(f"{API}/data-sources/{DB_ID}", headers=admin)).status_code == 204

    assert await _state(db, "o") == before
    assert before["frozen"] == {"patientIds": ["4242"], "count": 1} and before["run"]
