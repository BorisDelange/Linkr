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


async def _meta(client, headers, uid, path) -> dict:
    """Resolve one file's columns/rowCount via the lazy /meta endpoint (the list
    itself carries no meta — see test_scan_lists_names_only)."""
    return (await client.get(
        f"{API}/dataset-files/meta", headers=headers, params={"projectUid": uid, "path": path}
    )).json()


async def test_scan_lists_names_only(client, seed_roles):
    """The listing is lazy: files show up (names + tree) but WITHOUT columns/
    rowCount — those are resolved per file via /meta on open, so a big/CSV folder
    lists instantly."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "mortality.csv").write_text("age,sex\n70,M\n80,F\n,M\n")

    files = (await client.get(f"{API}/dataset-files", headers=h, params={"projectUid": uid})).json()
    node = {f["path"]: f for f in files}["mortality.csv"]
    assert node["type"] == "file"
    assert node["columns"] is None and node["rowCount"] is None


async def test_meta_resolves_columns_on_demand(client, seed_roles):
    """A CSV dropped straight into datasets/ gets inferred columns via /meta."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "mortality.csv").write_text("age,sex\n70,M\n80,F\n,M\n")

    meta = await _meta(client, h, uid, "mortality.csv")
    assert meta["rowCount"] == 3
    names = [(c["name"], c["type"]) for c in meta["columns"]]
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
    col_id = (await _meta(client, h, uid, "w.csv"))["columns"][0]["id"]
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
    col_id = (await _meta(client, h, uid, "d.csv"))["columns"][0]["id"]
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
    col_id = (await _meta(client, h, uid, "wards.csv"))["columns"][0]["id"]
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


async def test_native_parquet_rows_keyed_by_col_id(client, seed_roles):
    """A native parquet (real column names) resolves via /meta and its rows come
    back keyed by col_<slug> ids — not the raw parquet names — so the client table
    finds each cell (guards the native-column aliasing)."""
    import duckdb

    h = await _admin_headers(client)
    uid = await _project(client, h)
    p = _datasets(uid) / "person.parquet"
    con = duckdb.connect()
    con.execute("CREATE TABLE t(person_id INTEGER, gender VARCHAR)")
    con.execute("INSERT INTO t VALUES (1,'M'),(2,'F')")
    con.execute(f"COPY t TO '{p.as_posix()}' (FORMAT PARQUET)")
    con.close()

    meta = await _meta(client, h, uid, "person.parquet")
    ids = {c["name"]: c["id"] for c in meta["columns"]}
    assert set(ids) == {"person_id", "gender"} and meta["rowCount"] == 2

    r = await client.post(
        f"{API}/dataset-files/rows/query",
        headers=h, params={"projectUid": uid, "path": "person.parquet"},
        json={"offset": 0, "limit": 10},
    )
    body = r.json()
    assert body["total"] == 2
    assert set(body["rows"][0].keys()) == set(ids.values())

    # A filter by col id resolves against the aliased native column.
    r2 = await client.post(
        f"{API}/dataset-files/rows/query",
        headers=h, params={"projectUid": uid, "path": "person.parquet"},
        json={"offset": 0, "limit": 10, "filters": [{"colId": ids["gender"], "values": ["M"]}]},
    )
    assert r2.json()["total"] == 1


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


# --- Editorial column metadata sidecar (label/description/valueLabels) ---


def test_merge_column_meta_overlays_by_id():
    """Pure merge: editorial fields overlay derived columns by id; derived
    id/name/type/order stay; unknown ids are ignored; empty sidecar is a no-op."""
    cols = [
        {"id": "col_age", "name": "age", "type": "number", "order": 0},
        {"id": "col_sex", "name": "sex", "type": "string", "order": 1},
    ]
    sidecar = {"col_sex": {"label": "Sexe", "valueLabels": {"m": "Homme"}}, "col_x": {"label": "x"}}
    out = dataset_fs.merge_column_meta(cols, sidecar)
    assert out[0] == cols[0]  # untouched
    assert out[1]["label"] == "Sexe" and out[1]["valueLabels"] == {"m": "Homme"}
    assert out[1]["name"] == "sex" and out[1]["type"] == "string"  # derived preserved
    assert dataset_fs.merge_column_meta(cols, {}) == cols


async def test_column_meta_round_trip(client, seed_roles):
    """POST /columns/meta persists labels; /meta re-merges them onto the columns."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "cohort.csv").write_text("age,sex\n70,m\n80,f\n")
    await _meta(client, h, uid, "cohort.csv")  # build the cache first

    r = await client.post(
        f"{API}/dataset-files/columns/meta",
        headers=h,
        json={"projectUid": uid, "path": "cohort.csv", "columns": {
            "col_age": {"label": "Âge", "description": "Âge à l'inclusion"},
            "col_sex": {"label": "Sexe", "valueLabels": {"m": "Homme", "f": "Femme"}},
        }},
    )
    assert r.status_code == 200
    by_id = {c["id"]: c for c in r.json()["columns"]}
    assert by_id["col_age"]["label"] == "Âge"
    assert by_id["col_sex"]["valueLabels"] == {"m": "Homme", "f": "Femme"}
    # Re-fetch via /meta: labels persist independently of the write response.
    by_id = {c["id"]: c for c in (await _meta(client, h, uid, "cohort.csv"))["columns"]}
    assert by_id["col_age"]["description"] == "Âge à l'inclusion"


async def test_column_meta_survives_reparse(client, seed_roles):
    """The bug this fixes: labels must survive a raw-file change (cache reparse),
    unlike the derived columns which are rebuilt from the parquet."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    raw = _datasets(uid) / "cohort.csv"
    raw.write_text("age,sex\n70,m\n")
    await _meta(client, h, uid, "cohort.csv")
    await client.post(
        f"{API}/dataset-files/columns/meta", headers=h,
        json={"projectUid": uid, "path": "cohort.csv", "columns": {"col_sex": {"label": "Sexe"}}},
    )
    # Mutate the raw so the cache signature changes and /meta reparses.
    import time
    time.sleep(0.01)
    raw.write_text("age,sex\n70,m\n80,f\n90,m\n")
    meta = await _meta(client, h, uid, "cohort.csv")
    assert meta["rowCount"] == 3  # reparsed
    by_id = {c["id"]: c for c in meta["columns"]}
    assert by_id["col_sex"]["label"] == "Sexe"  # label survived the reparse


async def test_column_meta_clear_removes_sidecar(client, seed_roles):
    """Sending the authoritative full state without a column drops its metadata;
    an empty payload deletes the sidecar file entirely."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "cohort.csv").write_text("age,sex\n70,m\n")
    await _meta(client, h, uid, "cohort.csv")
    await client.post(
        f"{API}/dataset-files/columns/meta", headers=h,
        json={"projectUid": uid, "path": "cohort.csv", "columns": {"col_sex": {"label": "Sexe"}}},
    )
    assert dataset_fs.read_column_meta(uid, "cohort.csv") == {"col_sex": {"label": "Sexe"}}
    await client.post(
        f"{API}/dataset-files/columns/meta", headers=h,
        json={"projectUid": uid, "path": "cohort.csv", "columns": {}},
    )
    assert dataset_fs.read_column_meta(uid, "cohort.csv") == {}
    assert not dataset_fs._colmeta_path(uid, "cohort.csv").exists()


async def test_parse_options_survives_raw_change(client, seed_roles):
    """A forced column type persists in the sidecar and is re-applied when the raw
    file changes (the fragility Phase 2 fixes: a plain reparse used to re-infer)."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    raw = _datasets(uid) / "c.csv"
    raw.write_text("age,sex\n70,m\n")
    await _meta(client, h, uid, "c.csv")
    # Force age to string via reimport (persists parseOptions to the sidecar).
    r = await client.post(
        f"{API}/dataset-files/reimport", headers=h,
        json={"projectUid": uid, "path": "c.csv", "parseOptions": {"columnTypes": {"col_age": "string"}}},
    )
    assert {c["id"]: c["type"] for c in r.json()["columns"]}["col_age"] == "string"
    # Change the raw so the next /meta reparses with parseOptions=None.
    import time
    time.sleep(0.01)
    raw.write_text("age,sex\n70,m\n80,f\n")
    meta = await _meta(client, h, uid, "c.csv")
    assert {c["id"]: c["type"] for c in meta["columns"]}["col_age"] == "string"  # survived
    assert meta["parseOptions"]["columnTypes"] == {"col_age": "string"}


async def test_filter_mode_persists_via_sidecar(client, seed_roles):
    """columnFilterMode (pure-UI) persists through /columns/meta without a reparse,
    and a later columns-only write does not clobber it."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "c.csv").write_text("age,sex\n70,m\n")
    await _meta(client, h, uid, "c.csv")
    await client.post(
        f"{API}/dataset-files/columns/meta", headers=h,
        json={"projectUid": uid, "path": "c.csv", "parseOptions": {"columnFilterMode": {"col_sex": "list"}}},
    )
    meta = await _meta(client, h, uid, "c.csv")
    assert meta["parseOptions"]["columnFilterMode"] == {"col_sex": "list"}
    # A columns-only write must leave parseOptions intact.
    await client.post(
        f"{API}/dataset-files/columns/meta", headers=h,
        json={"projectUid": uid, "path": "c.csv", "columns": {"col_sex": {"label": "Sexe"}}},
    )
    meta = await _meta(client, h, uid, "c.csv")
    assert meta["parseOptions"]["columnFilterMode"] == {"col_sex": "list"}
    assert {c["id"]: c for c in meta["columns"]}["col_sex"]["label"] == "Sexe"
