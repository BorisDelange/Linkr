"""A view stored in an attached SQLite file runs with the connection's rights
without appearing in the query's text: every path that attaches such a file and
runs client SQL holds those definitions to the same check, on each run of a warm
connection too."""

import sqlite3

import duckdb
import pytest

from app.services.data import cohort_derive, connection_pool
from app.services.data.db_connect import materialize_parquet, query_file


def _sqlite_file(path, table: str, value: str, views: dict[str, str] | None = None) -> str:
    con = sqlite3.connect(path)
    con.execute(f"CREATE TABLE {table}(a TEXT)")
    con.execute(f"INSERT INTO {table} VALUES (?)", (value,))
    for name, select in (views or {}).items():
        con.execute(f"CREATE VIEW {name} AS {select}")
    con.commit()
    con.close()
    return str(path)


def _add_view(path: str, name: str, select: str) -> None:
    con = sqlite3.connect(path)
    con.execute(f"CREATE VIEW {name} AS {select}")
    con.commit()
    con.close()


@pytest.fixture
def other(tmp_path):
    return _sqlite_file(tmp_path / "other.sqlite", "theirs", "other-file-row")


_VIEWS = [
    "SELECT a FROM sqlite_scan('{other}', 'theirs')",
    "SELECT 'é' AS m, a FROM sqlite_scan('{other}', 'theirs')",
    "SELECT a FROM sqlite_scan\u200b('{other}', 'theirs')",
]


@pytest.mark.parametrize("view", _VIEWS)
def test_a_query_on_a_sqlite_database_reads_only_that_database(tmp_path, other, view):
    own = _sqlite_file(tmp_path / "own.sqlite", "mine", "own-row", {"v": view.format(other=other)})
    with pytest.raises(ValueError, match="not allowed"):
        query_file("sqlite", own, "SELECT * FROM v")


def test_a_view_added_to_a_warm_connection_is_checked_too(tmp_path, other):
    own = _sqlite_file(tmp_path / "own.sqlite", "mine", "own-row")
    key = "stored-view-warm"
    try:
        assert query_file("sqlite", own, "SELECT a FROM mine", pool_key=key) == [{"a": "own-row"}]
        _add_view(own, "v", _VIEWS[0].format(other=other))
        with pytest.raises(ValueError, match="not allowed"):
            query_file("sqlite", own, "SELECT * FROM v", pool_key=key)
    finally:
        connection_pool.invalidate(key)


@pytest.mark.parametrize("view", _VIEWS)
def test_a_materialized_cache_reads_only_its_database(tmp_path, other, view):
    own = _sqlite_file(tmp_path / "own.sqlite", "mine", "own-row", {"v": view.format(other=other)})
    out = tmp_path / "out.parquet"
    with pytest.raises(ValueError, match="not allowed"):
        materialize_parquet({"engine": "sqlite"}, None, [("own.sqlite", own)], [], "SELECT * FROM v", str(out))
    assert not out.exists()


@pytest.mark.parametrize("sql", [
    "SELECT a FROM sqlite_scan('{other}', 'theirs')",
    "SELECT * FROM query('SELECT a FROM sqlite_scan(''{other}'', ''theirs'')')",
])
def test_a_materialized_cache_query_reads_only_its_database(tmp_path, other, sql):
    own = _sqlite_file(tmp_path / "own.sqlite", "mine", "own-row")
    out = tmp_path / "out.parquet"
    with pytest.raises(ValueError, match="not allowed"):
        materialize_parquet({"engine": "sqlite"}, None, [("own.sqlite", own)], [], sql.format(other=other), str(out))
    assert not out.exists()


def test_a_materialized_cache_still_reads_its_database(tmp_path):
    own = _sqlite_file(tmp_path / "own.sqlite", "mine", "own-row", {"v": "SELECT upper(a) AS a FROM mine"})
    out = tmp_path / "out.parquet"
    materialize_parquet({"engine": "sqlite"}, None, [("own.sqlite", own)], [], "SELECT 'é' AS m, a FROM v", str(out))
    assert duckdb.execute(f"SELECT m, a FROM read_parquet('{out}')").fetchall() == [("é", "OWN-ROW")]


@pytest.mark.parametrize("view", _VIEWS)
def test_a_cohort_query_reads_only_its_source(tmp_path, other, view):
    own = _sqlite_file(tmp_path / "own.sqlite", "mine", "own-row", {"v": view.format(other=other)})
    with pytest.raises(ValueError, match="not allowed"):
        cohort_derive.compute_members(
            cohort_derive.SourceSpec(spec={"kind": "file", "engine": "sqlite", "path": own}),
            "SELECT 1 AS id, 1 AS patient_id FROM v",
        )


def test_a_sqlite_database_with_ordinary_views_still_answers(tmp_path):
    own = _sqlite_file(tmp_path / "own.sqlite", "mine", "own-row", {"v": "SELECT upper(a) AS a FROM mine"})
    assert query_file("sqlite", own, "SELECT a FROM v") == [{"a": "OWN-ROW"}]
    members = cohort_derive.compute_members(
        cohort_derive.SourceSpec(spec={"kind": "file", "engine": "sqlite", "path": own}),
        "SELECT 1 AS id, 1 AS patient_id FROM v",
    )
    assert members.num_rows == 1
