"""A database's concept profiles: written by an editor, read by everyone who
opens the database, summarised per section, dropped with its data."""

from app.core.security import hash_password
from app.models.data_source import DataSource
from app.models.user import User
from app.services import data_source_service

API = "/api/v1"


async def _headers(client, username: str) -> dict:
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _setup(client, db):
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    admin = await _headers(client, "admin")
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "WS"}})).json()["id"]
    ds = (await client.post(f"{API}/data-sources", headers=admin, json={
        "workspaceId": ws, "alias": "db", "name": "DB", "sourceType": "database",
        "connectionConfig": {"engine": "postgresql", "host": "h", "database": "omop"},
    })).json()["id"]
    bob = User(username="bob", password_hash=hash_password("pw-for-tests-only"), role="user")
    db.add(bob)
    await db.commit()
    await db.refresh(bob)
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin, json={"userId": bob.id, "role": "viewer"})
    return admin, await _headers(client, "bob"), ds


def _profile(concept_id: int, sections: list[str], fingerprint: str = "f1", **json) -> dict:
    return {
        "dictKey": "omop", "conceptId": concept_id, "rowsCount": 10, "patientsCount": 3,
        "json": json, "sections": sections, "variant": {"outlierMethod": "iqr", "outlierCoef": 1.5, "bins": "auto"},
        "fingerprint": fingerprint, "computedAt": "2026-11-02T00:00:00Z",
    }


async def test_written_once_read_by_everyone(client, db):
    admin, bob, ds = await _setup(client, db)
    body = {"profiles": [_profile(1, ["counts", "numeric"], numeric_data={"min": 1}), _profile(2, ["counts"])]}
    assert (await client.put(f"{API}/data-sources/{ds}/concept-profiles", headers=admin, json=body)).status_code == 204

    read = await client.post(f"{API}/data-sources/{ds}/concept-profiles/read", headers=bob,
                             json={"dictKey": "omop", "conceptIds": [1, 2, 3]})
    profiles = {p["conceptId"]: p for p in read.json()["profiles"]}
    assert set(profiles) == {1, 2}
    assert profiles[1]["json"] == {"numeric_data": {"min": 1}}
    assert profiles[1]["sections"] == ["counts", "numeric"]

    # A reader reads, never writes.
    assert (await client.put(f"{API}/data-sources/{ds}/concept-profiles", headers=bob, json=body)).status_code == 403


async def test_a_rewrite_replaces_the_concept(client, db):
    admin, _, ds = await _setup(client, db)
    url = f"{API}/data-sources/{ds}/concept-profiles"
    await client.put(url, headers=admin, json={"profiles": [_profile(1, ["counts"])]})
    await client.put(url, headers=admin, json={"profiles": [_profile(1, ["counts", "unit"], unit="mg")]})
    read = await client.post(f"{url}/read", headers=admin, json={"dictKey": "omop", "conceptIds": [1]})
    assert [p["json"] for p in read.json()["profiles"]] == [{"unit": "mg"}]


async def test_summary_counts_sections_fingerprints_and_the_run(client, db):
    admin, bob, ds = await _setup(client, db)
    url = f"{API}/data-sources/{ds}/concept-profiles"
    await client.put(url, headers=admin, json={"profiles": [
        _profile(1, ["counts", "numeric"]), _profile(2, ["counts"], fingerprint="f0"),
    ]})
    run = {"run": {"sections": ["numeric"], "extracted": 2}, "computedAt": "2026-11-02T00:00:00Z"}
    assert (await client.put(f"{url}/run", headers=admin, json=run)).status_code == 204
    summary = (await client.get(f"{url}/summary", headers=bob)).json()
    assert summary["count"] == 2
    assert summary["sections"]["counts"] == 2 and summary["sections"]["numeric"] == 1
    assert summary["fingerprints"] == {"f1": 1, "f0": 1}
    assert summary["run"] == {"sections": ["numeric"], "extracted": 2}


async def test_dropped_with_the_databases_data(client, db):
    admin, _, ds = await _setup(client, db)
    url = f"{API}/data-sources/{ds}/concept-profiles"
    await client.put(url, headers=admin, json={"profiles": [_profile(1, ["counts"])]})
    await data_source_service.invalidate_concept_caches(db, ds)
    assert (await client.get(f"{url}/summary", headers=admin)).json()["count"] == 0
    assert await db.get(DataSource, ds) is not None
