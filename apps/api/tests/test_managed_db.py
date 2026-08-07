"""Managed (server-owned, writable) DuckDB databases and ETL runs.

A pipeline target is created empty from a schema's DDL and written to by every
ETL script, so unlike an uploaded source it needs a mutable file of its own and
a connection where several databases are attached at once.
"""

import duckdb
import pytest

from app.services.data import db_connect, managed_db


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(type(settings), "data_path", property(lambda _: tmp_path))
    return tmp_path


DDL = """
CREATE TABLE person (person_id BIGINT, gender_concept_id INTEGER);
CREATE TABLE concept (concept_id BIGINT, concept_name VARCHAR);
"""


def test_create_from_ddl_makes_a_real_file_with_the_tables(data_dir):
    path = managed_db.create_from_ddl("11111111-1111-1111-1111-111111111111", DDL)
    con = duckdb.connect(path, read_only=True)
    tables = {r[0] for r in con.execute("SHOW TABLES").fetchall()}
    con.close()
    assert tables == {"person", "concept"}


def test_create_is_idempotent_and_leaves_no_half_schema(data_dir):
    sid = "22222222-2222-2222-2222-222222222222"
    managed_db.create_from_ddl(sid, DDL)
    managed_db.create_from_ddl(sid, "CREATE TABLE only_this (x INTEGER);")
    con = duckdb.connect(managed_db.path_for(sid).as_posix(), read_only=True)
    tables = {r[0] for r in con.execute("SHOW TABLES").fetchall()}
    con.close()
    assert tables == {"only_this"}


def test_a_failing_ddl_does_not_leave_a_file_behind(data_dir):
    sid = "33333333-3333-3333-3333-333333333333"
    with pytest.raises(Exception):
        managed_db.create_from_ddl(sid, "CREATE TABLE t (x INTEGER); NOT SQL AT ALL;")
    assert not managed_db.exists(sid)


def test_foreign_key_constraints_are_skipped(data_dir):
    """The OMOP DDL ends with ~176 `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN
    KEY`, which DuckDB rejects outright. Creating the database must still work —
    the browser path skips them the same way."""
    sid = "aaaaaaaa-0000-0000-0000-000000000000"
    ddl = DDL + """
    ALTER TABLE person ADD CONSTRAINT fpk_person_gender FOREIGN KEY
      (gender_concept_id) REFERENCES concept (concept_id);
    """
    managed_db.create_from_ddl(sid, ddl)
    con = duckdb.connect(managed_db.path_for(sid).as_posix(), read_only=True)
    tables = {r[0] for r in con.execute("SHOW TABLES").fetchall()}
    con.close()
    assert tables == {"person", "concept"}


def test_path_rejects_an_id_that_is_not_a_uuid(data_dir):
    with pytest.raises(ValueError):
        managed_db.path_for("../../etc/passwd")


def test_delete_removes_the_file(data_dir):
    sid = "44444444-4444-4444-4444-444444444444"
    managed_db.create_from_ddl(sid, DDL)
    managed_db.delete(sid)
    assert not managed_db.exists(sid)
    managed_db.delete(sid)  # no error on a second call


# --- ETL runs ---------------------------------------------------------------


def test_etl_writes_to_the_target_and_persists(data_dir):
    sid = "55555555-5555-5555-5555-555555555555"
    target = managed_db.create_from_ddl(sid, DDL)
    db_connect.run_etl_sql(target, "INSERT INTO target.person VALUES (1, 8507);")

    con = duckdb.connect(target, read_only=True)
    assert con.execute("SELECT count(*) FROM person").fetchone()[0] == 1
    con.close()


def test_unqualified_writes_land_on_the_target(data_dir):
    sid = "66666666-6666-6666-6666-666666666666"
    target = managed_db.create_from_ddl(sid, DDL)
    db_connect.run_etl_sql(target, "INSERT INTO person VALUES (2, 8532);")
    con = duckdb.connect(target, read_only=True)
    assert con.execute("SELECT person_id FROM person").fetchall() == [(2,)]
    con.close()


def test_one_statement_can_read_a_source_and_write_the_target(data_dir):
    """The reason for the in-memory hub: a per-source connection cannot do this."""
    src = data_dir / "raw.duckdb"
    con = duckdb.connect(src.as_posix())
    con.execute("CREATE TABLE patients (subject_id BIGINT)")
    con.execute("INSERT INTO patients VALUES (42), (43)")
    con.close()

    sid = "77777777-7777-7777-7777-777777777777"
    target = managed_db.create_from_ddl(sid, DDL)
    db_connect.run_etl_sql(
        target,
        "INSERT INTO target.person SELECT subject_id, 0 FROM source.patients;",
        {"source": {"kind": "file", "engine": "duckdb", "path": src.as_posix()}},
    )

    con = duckdb.connect(target, read_only=True)
    assert con.execute("SELECT count(*) FROM person").fetchone()[0] == 2
    con.close()


def test_a_role_database_is_read_only(data_dir):
    src = data_dir / "ro.duckdb"
    con = duckdb.connect(src.as_posix())
    con.execute("CREATE TABLE t (x INTEGER)")
    con.close()

    sid = "88888888-8888-8888-8888-888888888888"
    target = managed_db.create_from_ddl(sid, DDL)
    with pytest.raises(Exception):
        db_connect.run_etl_sql(
            target,
            "INSERT INTO source.t VALUES (1);",
            {"source": {"kind": "file", "engine": "duckdb", "path": src.as_posix()}},
        )


def test_a_parquet_role_is_reachable_by_role_name(data_dir):
    pq = data_dir / "d_items.parquet"
    con = duckdb.connect()
    con.execute(
        f"COPY (SELECT 220045 AS itemid, 'HR' AS label) TO '{pq}' (FORMAT parquet)"
    )
    con.close()

    sid = "99999999-9999-9999-9999-999999999999"
    target = managed_db.create_from_ddl(sid, DDL)
    rows = db_connect.run_etl_sql(
        target,
        "SELECT label FROM source.d_items;",
        {
            "source": {
                "kind": "parquet",
                "files": [("d_items.parquet", pq.as_posix())],
                "known": [],
            }
        },
    )
    assert rows == [{"label": "HR"}]
