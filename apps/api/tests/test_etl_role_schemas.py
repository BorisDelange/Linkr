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
    con.execute("CREATE TABLE hosp.transfers(n BIGINT)")
    con.execute("INSERT INTO hosp.transfers VALUES (1)")
    con.execute("CREATE TABLE icu.transfers(n BIGINT)")
    con.execute("INSERT INTO icu.transfers VALUES (1), (2)")
    con.execute("CREATE TABLE main.notes(n BIGINT)")
    con.execute("INSERT INTO main.notes VALUES (1), (2), (3), (4), (5)")
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


def _count(target_db):
    con = duckdb.connect(target_db, read_only=True)
    try:
        return con.execute("SELECT * FROM out_rows").fetchone()[0]
    finally:
        con.close()


def test_two_part_name_reaches_main_beside_other_schemas(target_db, multi_schema_source):
    """Once a role's schemas are on the path DuckDB stops looking in its `main`
    unless `main` is listed too — `vocab.concept` broke that way."""
    _run(target_db, multi_schema_source,
         "CREATE OR REPLACE TABLE target.out_rows AS SELECT count(*) FROM source.notes;")
    assert _count(target_db) == 5


def test_a_name_two_schemas_hold_is_refused(target_db, multi_schema_source):
    """`source.transfers` could be hosp's or icu's: refused, naming both."""
    with pytest.raises(ValueError, match=r"source\.transfers is ambiguous.*source\.hosp\.transfers or source\.icu\.transfers"):
        _run(target_db, multi_schema_source,
             "CREATE OR REPLACE TABLE target.out_rows AS SELECT count(*) FROM \"source\".transfers;")


def test_an_ambiguous_name_with_its_schema_runs(target_db, multi_schema_source):
    _run(target_db, multi_schema_source,
         "-- source.transfers\n"
         "CREATE OR REPLACE TABLE target.out_rows AS "
         "SELECT count(*) FROM source.icu.transfers WHERE 'source.transfers' <> '';")
    assert _count(target_db) == 2


def test_a_bare_name_two_schemas_hold_is_refused(target_db, multi_schema_source):
    """`FROM transfers` would silently read whichever of hosp/icu comes first."""
    with pytest.raises(ValueError, match=r"transfers is ambiguous.*source\.hosp\.transfers or source\.icu\.transfers"):
        _run(target_db, multi_schema_source,
             "CREATE OR REPLACE TABLE target.out_rows AS SELECT count(*) FROM transfers;")


def test_a_bare_name_the_script_or_the_target_holds_is_not_ambiguous(target_db, multi_schema_source):
    _run(target_db, multi_schema_source,
         "CREATE OR REPLACE TABLE target.out_rows AS "
         "WITH transfers AS (SELECT 1 AS n UNION ALL SELECT 2) SELECT count(*) FROM transfers;")
    assert _count(target_db) == 2
    _run(target_db, multi_schema_source,
         "CREATE TABLE transfers AS SELECT 7 AS n; "
         "CREATE OR REPLACE TABLE target.out_rows AS SELECT count(*) FROM transfers;")
    assert _count(target_db) == 1
    _run(target_db, multi_schema_source,
         "CREATE OR REPLACE TABLE target.out_rows AS SELECT sum(n) FROM transfers;")
    assert _count(target_db) == 7


def test_a_bare_name_one_schema_holds_still_resolves(target_db, multi_schema_source):
    _run(target_db, multi_schema_source,
         "CREATE OR REPLACE TABLE target.out_rows AS SELECT count(*) FROM patients;")
    assert _count(target_db) == 3
