"""An ETL run must not be blocked by a warm pooled connection on the same file.

DuckDB refuses to attach the same FILE twice in one process, whatever the alias.
Browsing a managed database leaves a pooled connection holding it READ_ONLY as
``ext``; without eviction a later ETL run asking for the same file as a writable
``target`` failed with "Unique file handle conflict" and STAYED broken until the
server restarted, because the pool kept the handle warm.
"""

import duckdb
import pytest

from app.services.data import connection_pool, db_connect


@pytest.fixture
def managed_db(tmp_path):
    path = tmp_path / "target.duckdb"
    con = duckdb.connect(str(path))
    con.execute("CREATE TABLE concept(concept_id BIGINT)")
    con.execute("INSERT INTO concept VALUES (1), (2)")
    con.close()
    yield str(path)
    connection_pool.clear()


def _warm_pool(key: str, path: str) -> None:
    """What browsing the database does: leave a warm READ_ONLY connection."""
    def setup():
        con = duckdb.connect()
        con.execute(f"ATTACH '{path}' AS ext (READ_ONLY)")
        return con

    connection_pool.run_pooled(key, setup, lambda c: [])


def test_warm_pool_blocks_the_run_without_eviction(managed_db):
    """The bug, pinned: this is why the fix has to exist."""
    _warm_pool("src-1", managed_db)
    with pytest.raises(Exception, match="Unique file handle conflict"):
        db_connect.run_etl_sql(managed_db, "DELETE FROM target.concept;")


def test_eviction_hands_the_file_to_the_run(managed_db):
    _warm_pool("src-1", managed_db)
    connection_pool.invalidate("src-1")
    # No raise: the file is free.
    db_connect.run_etl_sql(managed_db, "DELETE FROM target.concept;")


def test_browsing_still_works_after_a_run(managed_db):
    """Eviction must not leave the source unusable — the pool re-establishes."""
    _warm_pool("src-1", managed_db)
    connection_pool.invalidate("src-1")
    db_connect.run_etl_sql(managed_db, "DELETE FROM target.concept;")
    _warm_pool("src-1", managed_db)


def test_a_failed_run_does_not_keep_the_file(managed_db):
    """A script that raises mid-way still releases the handle, so the next run is
    not blocked by the previous failure (run_etl_sql closes in a finally)."""
    with pytest.raises(Exception):
        db_connect.run_etl_sql(managed_db, "SELECT * FROM target.does_not_exist;")
    db_connect.run_etl_sql(managed_db, "DELETE FROM target.concept;")


# --- Two roles on ONE database --------------------------------------------
#
# The same "Unique file handle conflict", a different cause: not a stale pooled
# handle but the run attaching one file twice itself, because the pipeline points
# two roles at the same database. Reading and writing one warehouse is a normal
# in-place transform, so it must work — and no restart ever fixed it, since the
# conflict is created fresh on every run.


def test_source_and_target_on_the_same_database(managed_db):
    """The reported bug: source == target must not fail to attach."""
    rows = db_connect.run_etl_sql(
        managed_db,
        "SELECT count(*) AS n FROM source.concept;",
        {"source": {"kind": "file", "engine": "duckdb", "path": managed_db}},
    )
    assert rows == [{"n": 2}]


def test_writing_target_while_reading_the_same_db_as_source(managed_db):
    """The point of the role mechanism: one statement reads one role, writes another."""
    db_connect.run_etl_sql(
        managed_db,
        "CREATE TABLE target.copied AS SELECT * FROM source.concept;",
        {"source": {"kind": "file", "engine": "duckdb", "path": managed_db}},
    )
    con = duckdb.connect(managed_db)
    try:
        assert con.execute("SELECT count(*) FROM copied").fetchone()[0] == 2
    finally:
        con.close()


def test_a_symlinked_path_is_recognised_as_the_same_file(tmp_path, managed_db):
    """Attach identity is the resolved path: DuckDB compares open handles, so a
    symlink to the target is the same file even though the string differs."""
    link = tmp_path / "link.duckdb"
    link.symlink_to(managed_db)
    rows = db_connect.run_etl_sql(
        managed_db,
        "SELECT count(*) AS n FROM source.concept;",
        {"source": {"kind": "file", "engine": "duckdb", "path": str(link)}},
    )
    assert rows == [{"n": 2}]


def test_three_roles_on_the_same_database(managed_db):
    spec = {"kind": "file", "engine": "duckdb", "path": managed_db}
    rows = db_connect.run_etl_sql(
        managed_db,
        "SELECT (SELECT count(*) FROM source.concept)"
        " + (SELECT count(*) FROM vocab.concept) AS n;",
        {"source": dict(spec), "vocab": dict(spec)},
    )
    assert rows == [{"n": 4}]


def test_a_genuinely_different_file_still_attaches_normally(tmp_path, managed_db):
    """The alias path must not swallow the ordinary case."""
    other = tmp_path / "other.duckdb"
    con = duckdb.connect(str(other))
    con.execute("CREATE TABLE patients(id BIGINT); INSERT INTO patients VALUES (9)")
    con.close()
    rows = db_connect.run_etl_sql(
        managed_db,
        "SELECT (SELECT count(*) FROM target.concept) AS t,"
        " (SELECT count(*) FROM source.patients) AS s;",
        {"source": {"kind": "file", "engine": "duckdb", "path": str(other)}},
    )
    assert rows == [{"t": 2, "s": 1}]


def test_the_alias_is_read_only(managed_db):
    """A role alias is a window onto the other database, not a second writable
    handle: the script writes through `target`."""
    with pytest.raises(Exception):
        db_connect.run_etl_sql(
            managed_db,
            "INSERT INTO source.concept VALUES (3);",
            {"source": {"kind": "file", "engine": "duckdb", "path": managed_db}},
        )
