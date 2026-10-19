"""A SQLite database file read through the server: the app's queries must run on
it as on a DuckDB file."""

import sqlite3

from app.services.data import db_connect


def _sqlite(tmp_path):
    path = tmp_path / "omop.sqlite"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE procedure_occurrence (person_id INTEGER, procedure_concept_id INTEGER)")
    con.execute("CREATE TABLE visit_occurrence (person_id INTEGER)")
    con.executemany("INSERT INTO procedure_occurrence VALUES (?, ?)", [(1, 10), (2, None), (3, 30)])
    con.executemany("INSERT INTO visit_occurrence VALUES (?)", [(1,), (2,)])
    con.commit()
    con.close()
    return str(path)


def test_a_relation_read_twice_in_one_query_runs_on_sqlite(tmp_path):
    # The shape of the concept and catalog counts: one class relation (a CTE) read
    # by two branches of a UNION, under a scalar subquery. DuckDB used to fail it
    # on a SQLite scan with "INTERNAL Error: Attempted to access index 0".
    sql = """
        WITH p AS NOT MATERIALIZED (SELECT person_id, procedure_concept_id AS c FROM procedure_occurrence)
        SELECT COUNT(*) AS visits,
               (SELECT COUNT(*) FROM (
                  SELECT person_id FROM p WHERE c IS NOT NULL
                  UNION ALL
                  SELECT person_id FROM p WHERE c IS NULL
               ) x) AS events
        FROM visit_occurrence
    """
    assert db_connect.query_file("sqlite", _sqlite(tmp_path), sql) == [{"visits": 2, "events": 3}]
