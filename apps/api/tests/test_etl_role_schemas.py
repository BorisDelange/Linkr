"""A role database with several schemas must stay readable from ETL SQL.

A clinical source rarely lives in one namespace: MIMIC-IV is published as ``hosp``
and ``icu``, eHOP spreads its tables over 11 Oracle schemas. Linkr used to flatten
every role into ``main``, so the whole question never arose — and the two shipped
MIMIC pipelines address the source as ``source.<table>``, which only works while
everything sits in that one schema.

The moment a role carries real schemas, ``source.patients`` is a two-part name
DuckDB resolves through the catalog search path. With the role's schemas absent
from it the lookup fails, and both pipelines break on ~24 references each. Putting
them on the path fixes that *and* keeps the bare-name form working, so nothing has
to migrate.

The path still keeps ``target`` first: an unqualified name must not silently fall
back to a read-only role.
"""

import duckdb
import pytest

from app.services.data import db_connect


@pytest.fixture
def target_db(tmp_path):
    path = tmp_path / "target.duckdb"
    con = duckdb.connect(str(path))
    con.execute("CREATE TABLE out_rows(n BIGINT)")
    con.close()
    return str(path)


@pytest.fixture
def multi_schema_source(tmp_path):
    """A role database shaped like MIMIC-IV: two modules, two schemas."""
    path = tmp_path / "source.duckdb"
    con = duckdb.connect(str(path))
    con.execute("CREATE SCHEMA hosp")
    con.execute("CREATE SCHEMA icu")
    con.execute("CREATE TABLE hosp.patients(subject_id BIGINT)")
    con.execute("INSERT INTO hosp.patients VALUES (1), (2), (3)")
    con.execute("CREATE TABLE icu.icustays(stay_id BIGINT)")
    con.execute("INSERT INTO icu.icustays VALUES (10), (20)")
    con.close()
    return str(path)


def _run(target, source, sql):
    return db_connect.run_etl_sql(
        target, sql, roles={"source": {"kind": "file", "path": source}}
    )


def test_two_part_name_reaches_a_schema_table(target_db, multi_schema_source):
    """`source.patients` — the form both shipped MIMIC pipelines use."""
    _run(target_db, multi_schema_source,
         "CREATE OR REPLACE TABLE target.out_rows AS SELECT count(*) FROM source.patients;")
    con = duckdb.connect(target_db, read_only=True)
    assert con.execute("SELECT * FROM out_rows").fetchone()[0] == 3
    con.close()


def test_two_part_name_reaches_every_schema(target_db, multi_schema_source):
    """Not just the first one on the path: `icu` resolves as readily as `hosp`."""
    _run(target_db, multi_schema_source,
         "CREATE OR REPLACE TABLE target.out_rows AS SELECT count(*) FROM source.icustays;")
    con = duckdb.connect(target_db, read_only=True)
    assert con.execute("SELECT * FROM out_rows").fetchone()[0] == 2
    con.close()


def test_three_part_name_still_works(target_db, multi_schema_source):
    """The explicit form, which the mapping's `schema` field will emit."""
    _run(target_db, multi_schema_source,
         "CREATE OR REPLACE TABLE target.out_rows AS SELECT count(*) FROM source.hosp.patients;")
    con = duckdb.connect(target_db, read_only=True)
    assert con.execute("SELECT * FROM out_rows").fetchone()[0] == 3
    con.close()


def test_a_wrong_schema_is_an_error_not_a_fallback(target_db, multi_schema_source):
    """`source.icu.patients` must fail: silently reading the wrong module would be
    worse than a broken run."""
    with pytest.raises(Exception, match="patients"):
        _run(target_db, multi_schema_source,
             "CREATE OR REPLACE TABLE target.out_rows AS "
             "SELECT count(*) FROM source.icu.patients;")


def test_target_still_wins_for_unqualified_names(target_db, multi_schema_source):
    """The reason the path was restricted in the first place: a bare name resolves
    against the writable target, never against a role that happens to share it."""
    con = duckdb.connect(target_db)
    con.execute("CREATE TABLE patients(subject_id BIGINT)")
    con.execute("INSERT INTO patients VALUES (99)")
    con.close()

    _run(target_db, multi_schema_source,
         "CREATE OR REPLACE TABLE target.out_rows AS SELECT count(*) FROM patients;")
    con = duckdb.connect(target_db, read_only=True)
    # 1 row (target's own table), not 3 (the source's).
    assert con.execute("SELECT * FROM out_rows").fetchone()[0] == 1
    con.close()


def test_single_schema_role_is_unaffected(target_db, tmp_path):
    """The overwhelmingly common shape must not regress."""
    flat = tmp_path / "flat.duckdb"
    con = duckdb.connect(str(flat))
    con.execute("CREATE TABLE patients(subject_id BIGINT)")
    con.execute("INSERT INTO patients VALUES (1), (2), (3), (4)")
    con.close()

    _run(target_db, str(flat),
         "CREATE OR REPLACE TABLE target.out_rows AS SELECT count(*) FROM source.patients;")
    con = duckdb.connect(target_db, read_only=True)
    assert con.execute("SELECT * FROM out_rows").fetchone()[0] == 4
    con.close()
