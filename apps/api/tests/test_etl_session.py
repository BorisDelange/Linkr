"""A script's statements share ONE connection, so session state carries.

The runner used to send each statement as its own HTTP request, and every
request opened a fresh DuckDB connection. Anything session-scoped was therefore
lost between statements: a ``SET VARIABLE`` set in statement 1 was gone by
statement 2, and ``query(getvariable(...))`` failed with the misleading
``syntax error at or near "NULL"`` — getvariable() returns NULL for an unset
variable, and query(NULL) tries to parse the string "NULL" as SQL.

Front-only never had the bug (DuckDB-WASM keeps one connection for the tab),
which is why a portable script could pass in the browser and fail on the server.
"""

import duckdb
import pytest

from app.services.data import connection_pool, db_connect


@pytest.fixture
def managed_db(tmp_path):
    path = tmp_path / "target.duckdb"
    con = duckdb.connect(str(path))
    con.execute("CREATE TABLE concept(concept_id BIGINT)")
    con.execute("INSERT INTO concept VALUES (1), (2), (3)")
    con.close()
    yield str(path)
    connection_pool.clear()


def test_set_variable_survives_to_the_next_statement(managed_db):
    """The exact regression, in the shape the prune script uses it."""
    rows = db_connect.run_etl_sql(
        managed_db,
        """
        SET VARIABLE linkr_scan = 'SELECT concept_id FROM target.concept';
        SELECT count(*) AS n FROM query(getvariable('linkr_scan'));
        """,
    )
    assert rows == [{"n": 3}]


def test_temp_table_survives_to_the_next_statement(managed_db):
    """The other session-scoped thing a script may reasonably reach for."""
    rows = db_connect.run_etl_sql(
        managed_db,
        """
        CREATE TEMPORARY TABLE kept AS SELECT concept_id FROM target.concept WHERE concept_id > 1;
        SELECT count(*) AS n FROM kept;
        """,
    )
    assert rows == [{"n": 2}]


def test_progress_is_reported_once_per_statement(managed_db):
    """Splitting server-side must still drive the per-statement progress UI."""
    seen: list[tuple[int, int]] = []
    db_connect.run_etl_sql(
        managed_db,
        "DELETE FROM target.concept WHERE concept_id = 1; SELECT 1 AS a; SELECT 2 AS b;",
        on_statement=lambda i, total, _sql: seen.append((i, total)),
    )
    assert seen == [(0, 3), (1, 3), (2, 3)]


def test_progress_names_the_statement_about_to_run(managed_db):
    """`next` is what the run is WAITING on, so the tooltip matches the counter."""
    seen: list[str] = []
    db_connect.run_etl_sql(
        managed_db,
        "SELECT 1 AS a; SELECT 2 AS b;",
        on_statement=lambda _i, _total, sql: seen.append(sql.strip()),
    )
    assert seen == ["SELECT 1 AS a", "SELECT 2 AS b"]


def test_last_statement_still_supplies_the_rows(managed_db):
    """Streaming progress must not change what the run returns."""
    rows = db_connect.run_etl_sql(
        managed_db, "SELECT 1 AS a; SELECT concept_id FROM target.concept ORDER BY 1;"
    )
    assert rows == [{"concept_id": 1}, {"concept_id": 2}, {"concept_id": 3}]
