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
