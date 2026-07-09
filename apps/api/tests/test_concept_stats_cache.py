"""Concept stats cache routes: per-(source, concept) shared stats, 404 until saved,
invalidated when the source changes."""

API = "/api/v1"


async def _admin_headers(client) -> dict:
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw"}
    )
    r = await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "pw"}
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
