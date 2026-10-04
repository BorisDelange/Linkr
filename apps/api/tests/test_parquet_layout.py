"""Parquet layout diagnostic: a table written in patient order is read by a
handful of row groups per patient, a shuffled one by all of them."""

import duckdb

from app.services.data.parquet_layout import column_layout

API = "/api/v1"


def _write(path, order: str) -> None:
    con = duckdb.connect()
    con.execute(
        f"COPY (SELECT (hash(r) % 1000)::BIGINT AS person_id, r AS v FROM range(100000) t(r) ORDER BY {order})"
        f" TO '{path}' (FORMAT PARQUET, ROW_GROUP_SIZE 10000)"
    )
    con.close()


def test_sorted_reads_few_row_groups_unsorted_reads_all(tmp_path):
    _write(tmp_path / "sorted.parquet", "person_id")
    _write(tmp_path / "shuffled.parquet", "v")

    sorted_ = column_layout([str(tmp_path / "sorted.parquet")], "person_id")
    shuffled = column_layout([str(tmp_path / "shuffled.parquet")], "person_id")
    assert sorted_["row_groups"] == shuffled["row_groups"] == 10
    assert sorted_["scan_fraction"] < 0.2
    assert shuffled["scan_fraction"] > 0.9


def test_column_is_matched_whatever_its_case_and_absent_is_empty(tmp_path):
    _write(tmp_path / "t.parquet", "person_id")
    assert column_layout([str(tmp_path / "t.parquet")], "PERSON_ID")["row_groups"] == 10
    assert column_layout([str(tmp_path / "t.parquet")], "nope") == {"row_groups": 0, "scan_fraction": None}


async def test_route_reports_each_table_of_a_parquet_folder(client, monkeypatch, tmp_path):
    from app.config import settings

    from tests.test_concept_stats_cache import _admin_headers, _workspace

    monkeypatch.setattr(settings, "fs_browse_roots", str(tmp_path))
    folder = tmp_path / "omop"
    folder.mkdir()
    _write(folder / "measurement.parquet", "v")
    _write(folder / "person.parquet", "person_id")

    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    r = await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "pq", "name": {"en": "PQ"}, "sourceType": "database",
        "connectionConfig": {"engine": "parquet", "serverPath": str(folder)},
    })
    assert r.status_code == 201, r.text
    src = r.json()["id"]

    r = await client.post(f"{API}/data-sources/{src}/parquet-layout", headers=headers, json={"checks": [
        {"table": "measurement", "column": "person_id"},
        {"table": "person", "column": "person_id"},
        {"table": "missing", "column": "person_id"},
    ]})
    assert r.status_code == 200, r.text
    by_table = {e["table"]: e for e in r.json()}
    assert set(by_table) == {"measurement", "person"}
    assert by_table["measurement"]["scanFraction"] > 0.9
    assert by_table["person"]["scanFraction"] < 0.2


def test_a_path_read_parquet_would_glob_is_left_out(tmp_path):
    # `a?.parquet` would also read `ab.parquet`.
    _write(tmp_path / "a?.parquet", "person_id")
    _write(tmp_path / "ab.parquet", "v")
    assert column_layout([str(tmp_path / "a?.parquet")], "person_id") == {"row_groups": 0, "scan_fraction": None}


async def test_route_dedupes_checks_and_never_borrows_another_schemas_table(client, monkeypatch, tmp_path):
    from app.config import settings

    from tests.test_concept_stats_cache import _admin_headers, _workspace

    monkeypatch.setattr(settings, "fs_browse_roots", str(tmp_path))
    folder = tmp_path / "wh"
    (folder / "hosp").mkdir(parents=True)
    (folder / "icu").mkdir()
    _write(folder / "hosp" / "person.parquet", "v")
    _write(folder / "icu" / "stays.parquet", "v")

    headers = await _admin_headers(client)
    ws = await _workspace(client, headers)
    r = await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "pq", "name": {"en": "PQ"}, "sourceType": "database",
        "connectionConfig": {"engine": "parquet", "serverPath": str(folder)},
    })
    assert r.status_code == 201, r.text
    src = r.json()["id"]

    r = await client.post(f"{API}/data-sources/{src}/parquet-layout", headers=headers, json={"checks": [
        {"schema": "hosp", "table": "person", "column": "person_id"},
        {"schema": "HOSP", "table": "PERSON", "column": "PERSON_ID"},
        {"schema": "icu", "table": "person", "column": "person_id"},
    ]})
    assert r.status_code == 200, r.text
    assert [(e["schema"], e["table"]) for e in r.json()] == [("hosp", "person")]
