"""datasets/ disk-source-of-truth: scan + derived Parquet cache (pagination/stats)."""

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


async def test_rows_query_column_filter_applies(client, seed_roles):
    """A column filter actually narrows the result (guards the camelCase key wiring
    between the API schema dump and _build_where)."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "w.csv").write_text("ward\nICU\nER\nICU\nWard\n")
    files = (await client.get(f"{API}/dataset-files", headers=h, params={"projectUid": uid})).json()
    col_id = files[0]["columns"][0]["id"]
    # Substring text filter → only the two ICU rows.
    r = await client.post(
        f"{API}/dataset-files/rows/query",
        headers=h, params={"projectUid": uid, "path": "w.csv"},
        json={"offset": 0, "limit": 10, "filters": [{"colId": col_id, "value": "icu"}]},
    )
    assert r.json()["total"] == 2
    # Categorical multi-select → ICU + ER rows.
    r2 = await client.post(
        f"{API}/dataset-files/rows/query",
        headers=h, params={"projectUid": uid, "path": "w.csv"},
        json={"offset": 0, "limit": 10, "filters": [{"colId": col_id, "values": ["ICU", "ER"]}]},
    )
    assert r2.json()["total"] == 3


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


async def test_column_distinct_over_cache(client, seed_roles):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "wards.csv").write_text("ward\nICU\nER\nICU\nWard\n")
    files = (await client.get(f"{API}/dataset-files", headers=h, params={"projectUid": uid})).json()
    col_id = files[0]["columns"][0]["id"]
    r = await client.get(
        f"{API}/dataset-files/columns/{col_id}/distinct",
        headers=h, params={"projectUid": uid, "path": "wards.csv"},
    )
    body = r.json()
    assert body["values"] == ["ER", "ICU", "Ward"]
    assert body["truncated"] is False
    # Search narrows (case-insensitive): "%er%" matches only "ER".
    r2 = await client.get(
        f"{API}/dataset-files/columns/{col_id}/distinct",
        headers=h, params={"projectUid": uid, "path": "wards.csv", "search": "er"},
    )
    assert r2.json()["values"] == ["ER"]


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


# --- Server-side preview (import dialog) ---

async def test_preview_matches_what_import_persists(client, seed_roles):
    """The /preview endpoint parses an uploaded blob without persisting, and the
    subsequent /import of the same blob yields the identical columns/rowCount —
    so the previewed schema is exactly what lands (no papaparse/DuckDB drift)."""
    from app.services import blob_store

    h = await _admin_headers(client)
    uid = await _project(client, h)
    # concept_code is numeric for its head then alphanumeric — the shape that used
    # to be mis-typed `number` and silently produce a column-less dataset.
    body = "".join(f"{200000 + i},lab{i}\n" for i in range(120)) + "G894,icd\n"
    sha, _ = await blob_store.store_bytes(b"concept_code,label\n" + body.encode())

    prev = await client.post(
        f"{API}/dataset-files/preview",
        headers=h,
        json={"projectUid": uid, "sha": sha, "fileName": "codes.csv"},
    )
    assert prev.status_code == 200
    pv = prev.json()
    types = {c["name"]: c["type"] for c in pv["columns"]}
    assert types == {"concept_code": "string", "label": "string"}
    assert pv["rowCount"] == 121
    assert len(pv["preview"]) <= 50

    imp = await client.post(
        f"{API}/dataset-files/import",
        headers=h,
        json={"projectUid": uid, "sha": sha, "path": "codes.csv"},
    )
    assert imp.status_code == 201
    node = imp.json()
    assert node["rowCount"] == pv["rowCount"]
    assert [(c["name"], c["type"]) for c in node["columns"]] == [
        (c["name"], c["type"]) for c in pv["columns"]
    ]


async def test_preview_honors_delimiter_option(client, seed_roles):
    from app.services import blob_store

    h = await _admin_headers(client)
    uid = await _project(client, h)
    sha, _ = await blob_store.store_bytes(b"a;b\n1;2\n3;4\n")
    prev = await client.post(
        f"{API}/dataset-files/preview",
        headers=h,
        json={
            "projectUid": uid, "sha": sha, "fileName": "semi.csv",
            "parseOptions": {"delimiter": ";"},
        },
    )
    assert prev.status_code == 200
    assert [c["name"] for c in prev.json()["columns"]] == ["a", "b"]


async def test_preview_path_reparses_existing_dataset(client, seed_roles):
    """Import Settings preview: re-parse the already-imported file with new options
    without persisting. Forcing a pipe delimiter re-splits a header the comma read
    kept whole, and no cache is written (the on-disk dataset is untouched)."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "s.csv").write_text("a|b\n1|2\n3|4\n")
    # Sniffed read auto-detects the pipe: two columns.
    r1 = await client.post(
        f"{API}/dataset-files/preview-path",
        headers=h, json={"projectUid": uid, "path": "s.csv"},
    )
    assert [c["name"] for c in r1.json()["columns"]] == ["a", "b"]
    # Forcing a comma delimiter overrides the sniffer: the pipes stay in one column.
    r2 = await client.post(
        f"{API}/dataset-files/preview-path",
        headers=h,
        json={"projectUid": uid, "path": "s.csv", "parseOptions": {"delimiter": ","}},
    )
    assert [c["name"] for c in r2.json()["columns"]] == ["a|b"]
    # Preview must not have written a Parquet cache (it's non-destructive).
    assert not list((project_fs.cache_dir(uid) / "datasets").glob("*.parquet"))
