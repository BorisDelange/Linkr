"""A pipeline script loads files but never writes one, whatever its table is
called: the direction of a COPY is read from its grammar, so a name part that is
a keyword, or a parenthesis inside a literal or a quoted name, cannot pass a
`COPY … TO` off as a load."""

import duckdb
import pytest

from app.services.data import db_connect


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


@pytest.mark.parametrize(("stmt", "writes"), [
    ("COPY target.main.from TO 'x'", True),
    ("COPY main.from TO 'x'", True),
    ("COPY from TO 'x'", True),
    ("COPY target.main.from (a) TO 'x'", True),
    ('COPY target.main."from" TO \'x\'', True),
    ("COPY (SELECT 666 AS id, ')' AS z) TO 'x'", True),
    ("COPY (SELECT 666 AS \")\" ) TO 'x'", True),
    ("COPY (SELECT 1 FROM t) TO 'x'", True),
    ("COPY ((SELECT 1)) TO 'x'", True),
    ("COPY t (a, b) TO 'x'", True),
    ("COPY main.to FROM 'x'", False),
    ("COPY target.main.from FROM 'x'", False),
    ("COPY t (a, b) FROM 'x' (HEADER)", False),
    ('COPY "to" FROM \'x\'', False),
    ("COPY FROM DATABASE a TO b", False),
])
def test_copy_direction_follows_the_grammar(stmt, writes):
    assert db_connect._copies_to_a_file(stmt) is writes


@pytest.mark.parametrize("stmt", [
    'CREATE TABLE "from" AS SELECT 666 AS id; COPY target.main.from TO \'{t}\' (FORMAT PARQUET, USE_TMP_FILE FALSE)',
    "COPY (SELECT 666 AS id, ')' AS z) TO '{t}' (FORMAT PARQUET, USE_TMP_FILE FALSE)",
    'CREATE TABLE "to" AS SELECT 666 AS id; COPY main.to TO \'{t}\' (FORMAT PARQUET, USE_TMP_FILE FALSE)',
])
def test_a_script_never_overwrites_its_inputs_through_a_table_named_like_a_keyword(target_db, parquet_role, stmt):
    table, role = parquet_role
    with pytest.raises(ValueError, match="not allowed"):
        db_connect.run_etl_sql(target_db, stmt.format(t=table), {"source": role})
    assert duckdb.execute(f"SELECT id FROM read_parquet('{table}') ORDER BY id").fetchall() == [(1,), (2,)]


def test_a_script_still_loads_a_mapping_into_a_table_named_like_a_keyword(target_db, parquet_role):
    _, role = parquet_role
    db_connect.run_etl_sql(
        target_db,
        'CREATE TABLE target.main."from" (source_code VARCHAR, source_concept_id BIGINT);'
        "COPY target.main.from FROM 'mapping.stcm' (HEADER);",
        {"source": role}, {"stcm": "source_code,source_concept_id\nA,2000000001\n"},
    )
    con = duckdb.connect(target_db, read_only=True)
    try:
        assert con.execute('SELECT COUNT(*) FROM "from"').fetchone()[0] == 1
    finally:
        con.close()
