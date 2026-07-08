"""datasets/ disk-source-of-truth: scan + derived Parquet cache (pagination/stats)."""

from app.config import settings
from app.services import project_fs
from app.services.data import dataset_fs

API = "/api/v1"


async def _admin_headers(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _project(client, headers) -> str:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    return (await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]


def _datasets(uid):
    return project_fs.datasets_dir(uid)  # ensures the dir exists


async def test_scan_lists_external_csv_with_columns(client, seed_roles):
    """A CSV dropped straight into datasets/ shows up with inferred columns."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "mortality.csv").write_text("age,sex\n70,M\n80,F\n,M\n")

    files = (await client.get(f"{API}/dataset-files", headers=h, params={"projectUid": uid})).json()
    by_path = {f["path"]: f for f in files}
    node = by_path["mortality.csv"]
    assert node["type"] == "file" and node["rowCount"] == 3
    names = [(c["name"], c["type"]) for c in node["columns"]]
    assert ("age", "number") in names and ("sex", "string") in names


async def test_rows_query_paginates_over_cache(client, seed_roles):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    lines = "n\n" + "\n".join(str(i) for i in range(50))
    (_datasets(uid) / "nums.csv").write_text(lines)

    r = await client.post(
        f"{API}/dataset-files/rows/query",
        headers=h, params={"projectUid": uid, "path": "nums.csv"},
        json={"offset": 0, "limit": 10},
    )
    body = r.json()
    assert body["total"] == 50 and len(body["rows"]) == 10


async def test_column_stats_over_cache(client, seed_roles):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "d.csv").write_text("age\n10\n20\n30\n")
    files = (await client.get(f"{API}/dataset-files", headers=h, params={"projectUid": uid})).json()
    col_id = files[0]["columns"][0]["id"]
    r = await client.get(
        f"{API}/dataset-files/columns/{col_id}/stats",
        headers=h, params={"projectUid": uid, "path": "d.csv"},
    )
    st = r.json()
    assert st["min"] == 10 and st["max"] == 30 and st["mean"] == 20


async def test_delete_purges_cache(client, seed_roles):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "gone.csv").write_text("a\n1\n")
    # Resolve once to build the cache.
    dataset_fs.resolve_cache(uid, "gone.csv")
    cache_root = project_fs.cache_dir(uid) / "datasets"
    assert list(cache_root.glob("*.parquet"))
    r = await client.post(f"{API}/dataset-files/delete", headers=h, json={"projectUid": uid, "path": "gone.csv"})
    assert r.status_code == 204
    assert not (_datasets(uid) / "gone.csv").exists()
    assert not list(cache_root.glob("*.parquet"))


async def test_analysis_keyed_by_path_and_reconciled_on_delete(client, seed_roles):
    """An analysis attaches to a dataset by path; deleting the dataset (or losing
    the raw file) removes the orphaned analysis on the next scan."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "cohort.csv").write_text("age\n1\n2\n")

    a = (await client.post(f"{API}/dataset-files/analyses", headers=h, json={
        "projectUid": uid, "datasetPath": "cohort.csv", "name": "A1", "type": "table1", "config": {},
    })).json()
    assert a["datasetPath"] == "cohort.csv"

    listed = (await client.get(f"{API}/dataset-files/analyses", headers=h, params={"projectUid": uid, "path": "cohort.csv"})).json()
    assert len(listed) == 1 and listed[0]["id"] == a["id"]

    # Delete the dataset → its analysis is reconciled away.
    await client.post(f"{API}/dataset-files/delete", headers=h, json={"projectUid": uid, "path": "cohort.csv"})
    after = (await client.get(f"{API}/dataset-files/analyses", headers=h, params={"projectUid": uid, "path": "cohort.csv"})).json()
    assert after == []


async def test_analysis_reconciled_when_raw_removed_externally(client, seed_roles):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "d.csv").write_text("x\n1\n")
    await client.post(f"{API}/dataset-files/analyses", headers=h, json={
        "projectUid": uid, "datasetPath": "d.csv", "name": "A", "type": "table1", "config": {},
    })
    # Remove the raw file outside the app, then a plain dataset scan reconciles.
    (_datasets(uid) / "d.csv").unlink()
    await client.get(f"{API}/dataset-files", headers=h, params={"projectUid": uid})
    after = (await client.get(f"{API}/dataset-files/analyses", headers=h, params={"projectUid": uid, "path": "d.csv"})).json()
    assert after == []


async def test_cache_reused_until_raw_changes(client, seed_roles):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    raw = _datasets(uid) / "c.csv"
    raw.write_text("a\n1\n")
    r1 = dataset_fs.resolve_cache(uid, "c.csv")
    assert r1["rowCount"] == 1
    # Rewrite with more rows → cache invalidated by (mtime,size) change.
    raw.write_text("a\n1\n2\n3\n")
    r2 = dataset_fs.resolve_cache(uid, "c.csv")
    assert r2["rowCount"] == 3
