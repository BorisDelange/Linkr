"""An ETL run reaches its own inputs and nothing else on the server.

It used to leave external access fully on whenever a role read Parquet files or
the script read a mapping CSV — which let a pipeline script read or write any
path the server can. The run is now confined like the read routes: the attached
databases, its parquet roles' files and its mapping CSVs, read-only."""

import duckdb
import pytest

from app.services.data import db_connect

CSV = "source_code,source_concept_id\nA,2000000001\n"


@pytest.fixture
def target_db(tmp_path):
    path = tmp_path / "target.duckdb"
    duckdb.connect(str(path)).close()
    return str(path)


@pytest.fixture
def parquet_role(tmp_path):
    table = tmp_path / "blobs" / "abc123"
    table.parent.mkdir()
    duckdb.execute(f"COPY (SELECT 1 AS id UNION ALL SELECT 2) TO '{table}' (FORMAT PARQUET)")
    return table, {"kind": "parquet", "files": [("patients.parquet", str(table))], "known": ["patients"]}


def _run(target, sql, role=None, mapping=None):
    return db_connect.run_etl_sql(
        target, sql, roles={"source": role} if role else None, mapping_data=mapping,
    )


def _count(target, table) -> int:
    con = duckdb.connect(target, read_only=True)
    try:
        return con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    finally:
        con.close()


def test_reads_its_parquet_role_and_mapping_csv(target_db, parquet_role):
    _, role = parquet_role
    _run(
        target_db,
        "CREATE TABLE target.person AS SELECT id FROM source.patients;"
        "CREATE TABLE target.stcm AS SELECT * FROM read_csv('mapping.stcm');"
        "CREATE TABLE target.loaded (source_code VARCHAR, source_concept_id BIGINT);"
        "COPY target.loaded FROM 'mapping.stcm' (HEADER);",
        role, {"stcm": CSV},
    )
    assert _count(target_db, "person") == 2
    assert _count(target_db, "stcm") == 1
    assert _count(target_db, "loaded") == 1


def test_cannot_read_other_files(target_db, parquet_role, tmp_path):
    _, role = parquet_role
    secret = tmp_path / "secret.csv"
    secret.write_text("password\nhunter2\n")
    with pytest.raises(duckdb.Error, match="disabled by configuration|Cannot access file"):
        _run(target_db, f"CREATE TABLE target.x AS SELECT * FROM read_csv('{secret}')", role, {"stcm": CSV})


def test_cannot_write_other_files(target_db, parquet_role, tmp_path):
    _, role = parquet_role
    out = tmp_path / "out.csv"
    with pytest.raises(ValueError):
        _run(target_db, f"COPY (SELECT 1) TO '{out}'", role)
    assert not out.exists()


@pytest.mark.parametrize("prefix", ["", "/* x */ ", "SELECT 1; "])
def test_cannot_overwrite_its_own_parquet_inputs(target_db, parquet_role, prefix):
    table, role = parquet_role
    with pytest.raises(ValueError):
        _run(
            target_db,
            f"{prefix}COPY (SELECT 99 AS id) TO '{table}' (FORMAT PARQUET, USE_TMP_FILE FALSE)",
            role,
        )
    assert duckdb.execute(f"SELECT id FROM read_parquet('{table}') ORDER BY id").fetchall() == [(1,), (2,)]


@pytest.mark.parametrize("disguise", [
    "EXPLAIN ANALYZE {copy}",
    "EXPLAIN (ANALYZE) {copy}",
    "PREPARE q AS {copy}; EXECUTE q",
])
def test_cannot_overwrite_its_inputs_through_explain_or_prepare(target_db, parquet_role, disguise):
    table, role = parquet_role
    copy = f"COPY (SELECT 99 AS id) TO '{table}' (FORMAT PARQUET, USE_TMP_FILE FALSE)"
    with pytest.raises(ValueError):
        _run(target_db, disguise.format(copy=copy), role)
    assert duckdb.execute(f"SELECT id FROM read_parquet('{table}') ORDER BY id").fetchall() == [(1,), (2,)]


@pytest.mark.parametrize("stmt", [
    "COPY (SELECT 99 AS id) TO/**/'{out}'",
    "COPY/**/(SELECT 99 AS id) TO '{out}'",
    "COPY (SELECT 99 AS id) TO--c\n'{out}'",
    "COPY (SELECT 99 AS id) /*(*/ TO '{out}'",
    "EXPLAIN (ANALYZE/**/) COPY (SELECT 99 AS id) TO '{out}'",
    "EXPLAIN (\"analyze\") COPY (SELECT 99 AS id) TO '{out}'",
    "EXPORT DATABASE '{dir}'",
    "EXPORT DATABASE target TO '{dir}'",
    "COPY FROM DATABASE target TO memory",
])
def test_cannot_write_a_file_through_comments_or_other_statements(target_db, parquet_role, tmp_path, stmt):
    _, role = parquet_role
    out, export_dir = tmp_path / "out.parquet", tmp_path / "export"
    with pytest.raises(ValueError):
        _run(target_db, stmt.format(out=out, dir=export_dir), role)
    assert not out.exists()
    assert not export_dir.exists()


def test_cannot_turn_external_access_back_on(target_db, parquet_role):
    _, role = parquet_role
    with pytest.raises(duckdb.Error):
        _run(target_db, "SET enable_external_access=true", role)


@pytest.mark.parametrize(("stmt", "writes"), [
    ("COPY (SELECT a FROM t) TO 'x'", True),
    ("copy t TO 'x' (FORMAT CSV)", True),
    ("COPY t (a, b) TO 'x'", True),
    ("COPY t FROM 'x'", False),
    ("COPY t (a, b) FROM 'x' (HEADER)", False),
    ('COPY "to" FROM \'x\'', False),
    ("COPY FROM DATABASE a TO b", False),
    ("COPY t TO/**/'x'", True),
    ("COPY/**/t TO 'x'", True),
    ("COPY t TO--c\n'x'", True),
    ("copy t from/**/'x'", False),
    ("SELECT 'COPY t TO x'", False),
])
def test_copy_direction(stmt, writes):
    assert db_connect._copies_to_a_file(stmt) is writes
