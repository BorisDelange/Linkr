"""Concept stats cache routes: per-(source, concept) shared stats, 404 until saved,
invalidated when the source changes."""

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


async def test_source_update_clears_stats(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    src = await _source(client, headers, ws)
    await client.put(
        f"{API}/data-sources/{src}/concept-stats/1", headers=headers, json={"stats": _STATS}
    )
    await client.patch(f"{API}/data-sources/{src}", headers=headers, json={"name": "PG2"})
    r = await client.get(f"{API}/data-sources/{src}/concept-stats/1", headers=headers)
    assert r.status_code == 404


async def test_cache_status_empty(client):
    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    src = await _source(client, headers, ws)
    r = await client.get(f"{API}/data-sources/{src}/concept-cache", headers=headers)
    assert r.status_code == 200
    assert r.json()["exists"] is False


async def test_counting_run_routes(client, monkeypatch, tmp_path):
    """Start a run, write a unit, assemble: the status reports the unit, and the
    page query reads the assembled list."""
    import duckdb

    from app.config import settings

    monkeypatch.setattr(settings, "fs_browse_roots", str(tmp_path))
    db = tmp_path / "src.duckdb"
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

    unit = {"sql": "SELECT 'd' AS dict_key, concept_id, COUNT(*)::BIGINT AS record_count, "
                   "COUNT(DISTINCT person_id)::BIGINT AS patient_count FROM measurement GROUP BY concept_id",
            "runId": "r1"}
    assert (await client.post(f"{base}/units/records-0", headers=headers, json=unit)).status_code == 409

    r = await client.put(f"{base}/run", headers=headers, json={"manifest": {"signature": "s", "runId": "r1"}, "reset": True})
    assert r.status_code == 204
    r = await client.post(f"{base}/units/records-0", headers=headers, json=unit)
    assert r.status_code == 204, r.text

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
