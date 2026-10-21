"""Concept stats cache routes: per-(source, concept) shared stats, 404 until saved,
invalidated when the source changes."""

import os
import time

API = "/api/v1"


async def _admin_headers(client) -> dict:
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"}
    )
    r = await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"}
    )
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _workspace(client, headers) -> str:
    return (
        await client.post(
            f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}}
        )
    ).json()["id"]


async def _source(client, headers, ws) -> str:
    return (
        await client.post(
            f"{API}/data-sources",
            headers=headers,
            json={
                "workspaceId": ws,
                "alias": "pg",
                "name": "PG",
                "sourceType": "database",
                "connectionConfig": {"engine": "postgresql", "host": "h"},
            },
        )
    ).json()["id"]


_STATS = {"rowCount": 42, "histogram": [{"bin_start": 0, "count": 5}]}


async def test_get_is_404_before_save(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    src = await _source(client, headers, ws)
    r = await client.get(f"{API}/data-sources/{src}/concept-stats/1", headers=headers)
    assert r.status_code == 404


async def test_save_then_get(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    src = await _source(client, headers, ws)
    put = await client.put(
        f"{API}/data-sources/{src}/concept-stats/1", headers=headers, json={"stats": _STATS}
    )
    assert put.status_code == 200
    got = (
        await client.get(f"{API}/data-sources/{src}/concept-stats/1", headers=headers)
    ).json()
    assert got["conceptId"] == 1
    assert got["stats"]["rowCount"] == 42


async def test_source_retarget_clears_stats(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    src = await _source(client, headers, ws)
    await client.put(
        f"{API}/data-sources/{src}/concept-stats/1", headers=headers, json={"stats": _STATS}
    )
    await client.patch(
        f"{API}/data-sources/{src}", headers=headers,
        json={"connectionConfig": {"engine": "postgresql", "host": "other"}},
    )
    r = await client.get(f"{API}/data-sources/{src}/concept-stats/1", headers=headers)
    assert r.status_code == 404


async def test_status_and_name_updates_keep_stats(client):
    """A re-test writes the status and stats back on every database page opened:
    the caches must outlive it, or the loaded concepts vanished on each visit."""
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    src = await _source(client, headers, ws)
    await client.put(
        f"{API}/data-sources/{src}/concept-stats/1", headers=headers, json={"stats": _STATS}
    )
    for change in (
        {"status": "connected", "errorMessage": None, "stats": {"tableCount": 3}},
        {"name": "PG2"},
        {"connectionConfig": {"engine": "postgresql", "host": "h"}},
    ):
        await client.patch(f"{API}/data-sources/{src}", headers=headers, json=change)
    r = await client.get(f"{API}/data-sources/{src}/concept-stats/1", headers=headers)
    assert r.status_code == 200


async def test_cache_status_empty(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    src = await _source(client, headers, ws)
    r = await client.get(f"{API}/data-sources/{src}/concept-cache", headers=headers)
    assert r.status_code == 200
    assert r.json()["exists"] is False


async def test_counting_run_routes(client, monkeypatch, tmp_path_factory):
    """Start a run, count a unit in a job, assemble: the status reports the unit,
    and the page query reads the assembled list."""
    import duckdb

    from app.config import settings
    from app.services.execution import jobs

    # Not tmp_path: that is the tests' data dir, which a serverPath may never touch.
    server_dir = tmp_path_factory.mktemp("server")
    monkeypatch.setattr(settings, "fs_browse_roots", str(server_dir))
    db = server_dir / "src.duckdb"
    con = duckdb.connect(str(db))
    con.execute("CREATE TABLE concept AS SELECT * FROM (VALUES (1, 'Sodium'), (2, 'Urea')) t(concept_id, concept_name)")
    con.execute("CREATE TABLE measurement AS SELECT * FROM (VALUES (1, 1), (2, 1)) t(person_id, concept_id)")
    con.close()

    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    src = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "db", "name": {"en": "DB"}, "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "serverPath": str(db)},
    })).json()["id"]
    base = f"{API}/data-sources/{src}/concept-cache"

    job = {"label": "Concepts", "runId": "r1", "units": [{
        "key": "records-0",
        "sql": "SELECT 'd' AS dict_key, concept_id, COUNT(*)::BIGINT AS record_count, "
               "COUNT(DISTINCT person_id)::BIGINT AS patient_count FROM measurement GROUP BY concept_id",
    }]}
    assert (await client.post(f"{base}/units-job", headers=headers, json=job)).status_code == 409

    r = await client.put(f"{base}/run", headers=headers, json={"manifest": {"signature": "s", "runId": "r1"}, "reset": True})
    assert r.status_code == 204
    r = await client.post(f"{base}/units-job", headers=headers, json=job)
    assert r.status_code == 202, r.text
    await jobs._tasks[r.json()["id"]]

    assemble = {"selectSql": "SELECT c.concept_id, c.concept_name, n.record_count, n.patient_count FROM concept c "
                             "LEFT JOIN memory.main._concept_counts n ON n.concept_id = c.concept_id"}
    r = await client.post(f"{base}/assemble", headers=headers, json=assemble)
    assert r.status_code == 200, r.text
    assert r.json()["exists"] is True

    status = (await client.get(base, headers=headers)).json()
    assert status["run"]["manifest"] == {"signature": "s", "runId": "r1"}
    assert status["run"]["doneUnits"] == ["records-0"]

    rows = (await client.post(f"{base}/query", headers=headers, json={"sql": "SELECT * FROM concepts ORDER BY concept_id"})).json()["rows"]
    assert [(r["concept_id"], r["record_count"], r["patient_count"]) for r in rows] == [(1, 2, 2), (2, None, None)]


async def test_precomputed_stats_are_planned_counted_and_served_first(client, monkeypatch, tmp_path_factory):
    """The `stats` step: ranges packed from the record units, a unit counted in a
    job, then served for the concept ahead of the stats a click cached."""
    import duckdb

    from app.config import settings
    from app.services.execution import jobs

    server_dir = tmp_path_factory.mktemp("server")
    monkeypatch.setattr(settings, "fs_browse_roots", str(server_dir))
    db = server_dir / "src.duckdb"
    con = duckdb.connect(str(db))
    con.execute("CREATE TABLE measurement AS SELECT * FROM (VALUES (1, 2.0), (1, 4.0), (2, 1.0)) t(concept_id, v)")
    con.close()
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    src = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "db", "name": {"en": "DB"}, "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "serverPath": str(db)},
    })).json()["id"]
    base = f"{API}/data-sources/{src}/concept-cache"
    units = [{"key": "records-0-std", "step": "records"}, {"key": "stats-1-of-1", "step": "stats"}]
    await client.put(f"{base}/run", headers=headers, json={"manifest": {"runId": "r1", "units": units}, "reset": True})

    async def run(key: str, sql: str) -> None:
        r = await client.post(f"{base}/units-job", headers=headers, json={"label": "C", "runId": "r1", "units": [{"key": key, "sql": sql}]})
        assert r.status_code == 202, r.text
        await jobs._tasks[r.json()["id"]]

    await run("records-0-std", "SELECT 'd' AS dict_key, concept_id, COUNT(*)::BIGINT AS record_count, "
              "NULL::BIGINT AS patient_count, 'ev' AS relation, 's' AS relation_sig FROM measurement GROUP BY concept_id")
    plan = await client.post(f"{base}/stats-plan", headers=headers, json={"dicts": [{"dictKey": "d", "relations": ["ev"]}], "maxRows": 2})
    assert plan.json() == {"ranges": [{"dictKey": "d", "lo": None, "hi": 1}, {"dictKey": "d", "lo": 2, "hi": None}]}

    await client.put(f"{API}/data-sources/{src}/concept-stats/1", headers=headers, json={"stats": _STATS})
    await run("stats-1-of-1", "SELECT 'd' AS dict_key, concept_id, 0::BIGINT AS bin, COUNT(*)::BIGINT AS bin_count, "
              "COUNT(*)::BIGINT AS value_count, MIN(v) AS min_val, MAX(v) AS max_val, AVG(v) AS mean_val, "
              "STDDEV_SAMP(v) AS std_val, MIN(v) AS p01, MIN(v) AS q1_val, MEDIAN(v) AS median_val, MAX(v) AS q3_val, "
              "MAX(v) AS p99 FROM measurement GROUP BY concept_id")
    got = (await client.get(f"{API}/data-sources/{src}/concept-stats/1?dictKey=d", headers=headers)).json()
    assert got["stats"]["rowCount"] == 2
    assert got["stats"]["distribution"]["median_val"] == 3.0
    assert got["stats"]["histogramVariant"] == "p1p99-union-approx"

    # Stats a click computed after the run are the newer ones.
    from app.services.data import concept_cache_fs

    for unit in concept_cache_fs._unit_files(src, ""):
        os.utime(unit, (time.time() - 3600, time.time() - 3600))
    await client.put(f"{API}/data-sources/{src}/concept-stats/1", headers=headers, json={"stats": _STATS})
    got = (await client.get(f"{API}/data-sources/{src}/concept-stats/1?dictKey=d", headers=headers)).json()
    assert got["stats"] == _STATS


async def _managed(client, headers, ws) -> str:
    src = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "m", "name": {"en": "M"}, "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "managed": True},
    })).json()["id"]
    r = await client.post(f"{API}/data-sources/{src}/create-from-ddl", headers=headers, json={"ddl": "CREATE TABLE t (x BIGINT);"})
    assert r.status_code == 200, r.text
    return src


async def test_a_rebuild_from_ddl_drops_the_concept_caches(client):
    """A rebuild in place keeps the config as it was: the caches go all the same."""
    from app.services.data import concept_cache_fs

    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    src = await _managed(client, headers, ws)
    await client.put(f"{API}/data-sources/{src}/concept-stats/1", headers=headers, json={"stats": _STATS})
    concept_cache_fs.write_manifest(src, "", {"runId": "r1"}, reset=True)

    r = await client.post(f"{API}/data-sources/{src}/create-from-ddl", headers=headers, json={"ddl": "CREATE TABLE u (y BIGINT);"})
    assert r.status_code == 200, r.text
    assert (await client.get(f"{API}/data-sources/{src}/concept-stats/1", headers=headers)).status_code == 404
    assert concept_cache_fs.run_status(src, "") is None


async def test_the_diagnosis_is_for_those_who_can_compute_the_stats(client, db):
    from app.core.security import hash_password
    from app.models.user import User

    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    src = await _managed(client, headers, ws)
    viewer = User(username="viewer", password_hash=hash_password("pw-for-tests-only"), role="user")
    db.add(viewer)
    await db.commit()
    await client.put(f"{API}/workspaces/{ws}/members", headers=headers, json={"userId": viewer.id, "role": "viewer"})
    token = (await client.post(f"{API}/auth/login", json={"username": "viewer", "password": "pw-for-tests-only"})).json()["access_token"]

    url = f"{API}/data-sources/{src}/concept-stats/1/diagnose"
    assert (await client.get(url, headers={"Authorization": f"Bearer {token}"})).status_code == 403
    r = await client.get(url, headers=headers)
    assert r.status_code == 200
    assert r.json() == {"conceptId": 1, "statsUnitsPlanned": 0, "statsUnitsDone": 0, "covering": [], "inStatsUnits": [], "inRecordUnits": []}
