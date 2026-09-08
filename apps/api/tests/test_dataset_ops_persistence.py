"""The ops log end to end: sidecar persistence, append-vs-replace semantics, and
the Parquet cache re-derived as raw -> parse -> replay(ops).

The invariant under test throughout: the RAW FILE IS NEVER WRITTEN TO. Every edit
lives in the log, and what pagination/stats/the IDE read is the derived cache.
"""

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
    return project_fs.datasets_dir(uid)


def _op(op_id, **kwargs):
    return {"id": op_id, "at": 1_700_000_000_000, **kwargs}


async def _post_ops(client, headers, uid, path, ops, replace=False):
    return await client.post(
        f"{API}/dataset-files/ops",
        headers=headers,
        json={"projectUid": uid, "path": path, "ops": ops, "replace": replace},
    )


async def _rows(client, headers, uid, path):
    r = await client.post(
        f"{API}/dataset-files/rows/query",
        headers=headers,
        params={"projectUid": uid, "path": path},
        json={"offset": 0, "limit": 100},
    )
    return r.json()["rows"]


async def test_set_cell_changes_the_read_rows_but_not_the_raw(client, seed_roles):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    raw = _datasets(uid) / "vent.csv"
    raw.write_text("person_id,note\np1,a\np2,b\n")
    original = raw.read_text()

    r = await _post_ops(client, h, uid, "vent.csv", [
        _op("o1", type="setCell", row=1, column="col_note", value="edited"),
    ])
    assert r.status_code == 200

    rows = await _rows(client, h, uid, "vent.csv")
    assert [row["col_note"] for row in rows] == ["a", "edited"]
    assert raw.read_text() == original, "the raw file must never be written to"


async def test_ops_append_rather_than_replace(client, seed_roles):
    """Two editors each send only their own ops; neither drops the other's work."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "vent.csv").write_text("person_id,note\np1,a\np2,b\n")

    await _post_ops(client, h, uid, "vent.csv", [
        _op("first", type="setCell", row=0, column="col_note", value="by-A"),
    ])
    r = await _post_ops(client, h, uid, "vent.csv", [
        _op("second", type="setCell", row=1, column="col_note", value="by-B"),
    ])

    assert [op["id"] for op in r.json()["ops"]] == ["first", "second"]
    rows = await _rows(client, h, uid, "vent.csv")
    assert [row["col_note"] for row in rows] == ["by-A", "by-B"]


async def test_appending_the_same_op_twice_is_idempotent(client, seed_roles):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "vent.csv").write_text("person_id,note\np1,a\n")

    op = _op("retried", type="setCell", row=0, column="col_note", value="x")
    await _post_ops(client, h, uid, "vent.csv", [op])
    r = await _post_ops(client, h, uid, "vent.csv", [op])

    assert len(r.json()["ops"]) == 1


async def test_replace_rewrites_the_whole_log(client, seed_roles):
    """What compaction and reset-to-raw need."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "vent.csv").write_text("person_id,note\np1,a\n")

    await _post_ops(client, h, uid, "vent.csv", [
        _op("o1", type="setCell", row=0, column="col_note", value="one"),
        _op("o2", type="setCell", row=0, column="col_note", value="two"),
    ])
    r = await _post_ops(client, h, uid, "vent.csv", [
        _op("o2", type="setCell", row=0, column="col_note", value="two"),
    ], replace=True)

    assert [op["id"] for op in r.json()["ops"]] == ["o2"]
    assert (await _rows(client, h, uid, "vent.csv"))[0]["col_note"] == "two"


async def test_reset_to_raw_by_replacing_with_an_empty_log(client, seed_roles):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "vent.csv").write_text("person_id,note\np1,a\n")

    await _post_ops(client, h, uid, "vent.csv", [
        _op("o1", type="setCell", row=0, column="col_note", value="edited"),
    ])
    r = await _post_ops(client, h, uid, "vent.csv", [], replace=True)

    assert r.json()["ops"] == []
    assert (await _rows(client, h, uid, "vent.csv"))[0]["col_note"] == "a"


async def test_add_column_and_row_reach_the_cache(client, seed_roles):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "vent.csv").write_text("person_id\np1\n")

    r = await _post_ops(client, h, uid, "vent.csv", [
        _op("o1", type="addColumn", column="col_vent_start", name="vent_start", colType="string"),
        _op("o2", type="setCell", row=0, column="col_vent_start", value="2026-01-04"),
        _op("o3", type="addRow", row=-1, values={"col_person_id": "p2", "col_vent_start": "2026-01-09"}),
    ])

    node = r.json()["node"]
    assert [c["name"] for c in node["columns"]] == ["person_id", "vent_start"]
    assert node["rowCount"] == 2
    rows = await _rows(client, h, uid, "vent.csv")
    assert [row["col_person_id"] for row in rows] == ["p1", "p2"]
    assert [row["col_vent_start"] for row in rows] == ["2026-01-04", "2026-01-09"]


async def test_the_log_survives_a_raw_file_change(client, seed_roles):
    """Like parseOptions, the log is durable: re-parsing a changed raw re-applies
    the edits instead of silently discarding them."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    raw = _datasets(uid) / "vent.csv"
    raw.write_text("person_id,note\np1,a\np2,b\n")

    await _post_ops(client, h, uid, "vent.csv", [
        _op("o1", type="setCell", row=0, column="col_note", value="edited"),
    ])
    raw.write_text("person_id,note\np1,CHANGED\np2,b\np3,c\n")

    rows = await _rows(client, h, uid, "vent.csv")
    assert len(rows) == 3
    assert rows[0]["col_note"] == "edited", "the op still applies after a reparse"


async def test_cache_is_invalidated_by_the_ops_digest_alone(client, seed_roles):
    """The raw signature is unchanged between these two reads; only the log moved,
    so the ops digest is what has to invalidate the cache."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "vent.csv").write_text("person_id,note\np1,a\n")

    assert (await _rows(client, h, uid, "vent.csv"))[0]["col_note"] == "a"
    await _post_ops(client, h, uid, "vent.csv", [
        _op("o1", type="setCell", row=0, column="col_note", value="edited"),
    ])
    assert (await _rows(client, h, uid, "vent.csv"))[0]["col_note"] == "edited"


async def test_an_edited_parquet_gets_a_real_cache_instead_of_aliasing_the_raw(client, seed_roles):
    """An unedited .parquet is its own cache; once edited it must materialise, or
    replay would have to write the raw file."""
    import duckdb

    h = await _admin_headers(client)
    uid = await _project(client, h)
    raw = _datasets(uid) / "vent.parquet"
    con = duckdb.connect()
    con.execute(
        f"COPY (SELECT 'p1' AS person_id, 'a' AS note) TO '{raw.as_posix()}' (FORMAT PARQUET)"
    )
    con.close()
    before = raw.read_bytes()

    resolved = dataset_fs.resolve_cache(uid, "vent.parquet")
    assert resolved["parquet"] == raw and resolved["native"] is True

    await _post_ops(client, h, uid, "vent.parquet", [
        _op("o1", type="setCell", row=0, column="col_note", value="edited"),
    ])

    resolved = dataset_fs.resolve_cache(uid, "vent.parquet")
    assert resolved["parquet"] != raw, "an edited parquet must not alias its raw"
    assert raw.read_bytes() == before, "the raw parquet must never be written to"
    assert (await _rows(client, h, uid, "vent.parquet"))[0]["col_note"] == "edited"


async def test_ops_are_rejected_without_write_permission(client, seed_roles):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "vent.csv").write_text("person_id,note\np1,a\n")

    r = await client.post(
        f"{API}/dataset-files/ops",
        json={"projectUid": uid, "path": "vent.csv", "ops": []},
    )
    assert r.status_code in (401, 403)


async def test_ops_on_a_missing_dataset_are_404(client, seed_roles):
    h = await _admin_headers(client)
    uid = await _project(client, h)

    r = await _post_ops(client, h, uid, "nope.csv", [])
    assert r.status_code == 404


async def test_sidecar_keeps_column_meta_and_ops_side_by_side(client, seed_roles):
    """Both live in the one sidecar; writing one section must not wipe the other."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "vent.csv").write_text("person_id,note\np1,a\n")

    await client.post(f"{API}/dataset-files/columns/meta", headers=h, json={
        "projectUid": uid, "path": "vent.csv",
        "columns": {"col_note": {"label": "Clinical note"}},
    })
    await _post_ops(client, h, uid, "vent.csv", [
        _op("o1", type="setCell", row=0, column="col_note", value="edited"),
    ])

    assert dataset_fs.read_column_meta(uid, "vent.csv") == {"col_note": {"label": "Clinical note"}}
    assert len(dataset_fs.read_ops(uid, "vent.csv")) == 1


async def test_the_row_key_reaches_a_paged_client_only_when_edited(client, seed_roles):
    """A paged client sees one page of a sorted, filtered slice, so it can only say
    WHICH row an edit targets if the cache carries the row key. An unedited dataset
    has no log to address, so it must not carry the extra column."""
    from app.services.data.dataset_ops import ROW_ORD

    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "vent.csv").write_text("person_id,note\np1,a\np2,b\n")

    rows = await _rows(client, h, uid, "vent.csv")
    assert all(ROW_ORD not in r for r in rows), "unedited cache carries no row key"

    await _post_ops(client, h, uid, "vent.csv", [
        _op("o1", type="setCell", row=1, column="col_note", value="edited"),
    ])

    rows = await _rows(client, h, uid, "vent.csv")
    assert [r[ROW_ORD] for r in rows] == [0, 1]
    assert rows[1]["col_note"] == "edited"


async def test_the_row_key_is_not_a_column_the_ui_sees(client, seed_roles):
    """It is identity, not data: it must never reach the column list the table,
    the stats panel or an export read."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "vent.csv").write_text("person_id,note\np1,a\n")

    r = await _post_ops(client, h, uid, "vent.csv", [
        _op("o1", type="setCell", row=0, column="col_note", value="edited"),
    ])
    names = [c["name"] for c in r.json()["node"]["columns"]]
    assert names == ["person_id", "note"]


async def test_create_empty_lands_a_real_file_on_disk(client, seed_roles):
    """A manual collection has no upload behind it, but must still be a real file:
    created only in the client's memory, it vanished on the next reload."""
    h = await _admin_headers(client)
    uid = await _project(client, h)

    r = await client.post(
        f"{API}/dataset-files/create-empty",
        headers=h,
        json={"projectUid": uid, "path": "vent.csv", "columns": [
            {"id": "col_subject_id", "name": "subject_id"},
            {"id": "col_hadm_id", "name": "hadm_id"},
        ]},
    )
    assert r.status_code == 201
    assert [c["name"] for c in r.json()["columns"]] == ["subject_id", "hadm_id"]
    assert (_datasets(uid) / "vent.csv").read_text() == "subject_id,hadm_id\n"

    listed = await client.get(f"{API}/dataset-files", headers=h, params={"projectUid": uid})
    assert any(n["path"] == "vent.csv" for n in listed.json()), "must survive a re-listing"


async def test_create_empty_quotes_a_column_name_that_would_break_the_header(client, seed_roles):
    """A name holding a comma or a quote would otherwise reparse into different
    columns than the ones asked for."""
    h = await _admin_headers(client)
    uid = await _project(client, h)

    r = await client.post(
        f"{API}/dataset-files/create-empty",
        headers=h,
        json={"projectUid": uid, "path": "odd.csv", "columns": [
            {"id": "col_a", "name": 'weight, kg'},
            {"id": "col_b", "name": 'say "hi"'},
        ]},
    )
    assert r.status_code == 201
    assert [c["name"] for c in r.json()["columns"]] == ["weight, kg", 'say "hi"']


async def test_create_empty_refuses_to_clobber_an_existing_dataset(client, seed_roles):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "taken.csv").write_text("a\n1\n")

    r = await client.post(
        f"{API}/dataset-files/create-empty",
        headers=h,
        json={"projectUid": uid, "path": "taken.csv", "columns": [{"id": "col_x", "name": "x"}]},
    )
    assert r.status_code == 409
    assert (_datasets(uid) / "taken.csv").read_text() == "a\n1\n"


async def test_a_created_dataset_is_immediately_editable(client, seed_roles):
    """The whole point: collection writes land in it through the ops log."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    await client.post(
        f"{API}/dataset-files/create-empty",
        headers=h,
        json={"projectUid": uid, "path": "vent.csv", "columns": [
            {"id": "col_subject_id", "name": "subject_id"},
        ]},
    )

    r = await _post_ops(client, h, uid, "vent.csv", [
        _op("o1", type="addRow", row=-1, values={"col_subject_id": "p1"}),
    ])
    assert r.json()["node"]["rowCount"] == 1
    assert (await _rows(client, h, uid, "vent.csv"))[0]["col_subject_id"] == "p1"


async def test_adding_a_row_to_an_empty_dataset(client, seed_roles):
    """The collection case: a freshly created dataset holds only a header, and the
    first row added has no existing row to land after."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "vent.csv").write_text("person_id,note\n")

    r = await _post_ops(client, h, uid, "vent.csv", [
        _op("o1", type="addRow", row=-1, after=None),
    ])
    assert r.status_code == 200
    assert r.json()["node"]["rowCount"] == 1
    assert len(await _rows(client, h, uid, "vent.csv")) == 1


async def test_adding_a_row_at_the_end_of_a_populated_dataset(client, seed_roles):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "vent.csv").write_text("person_id,note\np1,a\np2,b\n")

    r = await _post_ops(client, h, uid, "vent.csv", [
        _op("o1", type="addRow", row=-1, after=None),
    ])
    assert r.json()["node"]["rowCount"] == 3
    rows = await _rows(client, h, uid, "vent.csv")
    assert [row["col_person_id"] for row in rows] == ["p1", "p2", None]


async def test_adding_several_rows_keeps_them_distinct(client, seed_roles):
    """Each added row must take its own ordinal — reusing one would make the second
    addRow a no-op against a row that already exists."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "vent.csv").write_text("person_id\np1\n")

    await _post_ops(client, h, uid, "vent.csv", [_op("o1", type="addRow", row=-1, after=None)])
    r = await _post_ops(client, h, uid, "vent.csv", [_op("o2", type="addRow", row=-2, after=None)])

    assert r.json()["node"]["rowCount"] == 3


async def test_the_log_rides_on_the_node_the_client_reads_back(client, seed_roles):
    """The client mints the next row ordinal from the log, so a node returned
    without it makes every added row reuse the same ordinal — and the second
    addRow is then a silent no-op against a row that already exists."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "vent.csv").write_text("person_id\np1\n")

    posted = await _post_ops(client, h, uid, "vent.csv", [
        _op("o1", type="addRow", row=-1, after=None),
    ])
    assert [op["id"] for op in posted.json()["node"]["ops"]] == ["o1"]

    meta = await client.get(
        f"{API}/dataset-files/meta", headers=h,
        params={"projectUid": uid, "path": "vent.csv"},
    )
    assert [op["id"] for op in meta.json()["ops"]] == ["o1"], "a reload must recover the log"


async def test_an_unedited_dataset_reports_no_log(client, seed_roles):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    (_datasets(uid) / "vent.csv").write_text("person_id\np1\n")

    meta = await client.get(
        f"{API}/dataset-files/meta", headers=h,
        params={"projectUid": uid, "path": "vent.csv"},
    )
    assert meta.json()["ops"] is None
