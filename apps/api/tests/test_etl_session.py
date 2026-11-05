"""A script's statements share ONE connection, so session state carries.

The runner used to send each statement as its own HTTP request, and every
request opened a fresh DuckDB connection. Anything session-scoped was therefore
lost between statements: a ``SET VARIABLE`` set in statement 1 was gone by
statement 2, where getvariable() read NULL.

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
    rows = db_connect.run_etl_sql(
        managed_db,
        """
        SET VARIABLE linkr_min = 2;
        SELECT count(*) AS n FROM target.concept WHERE concept_id >= getvariable('linkr_min');
        """,
    )
    assert rows == [{"n": 2}]


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


@pytest.mark.parametrize("sql", [
    "SELECT * FROM query('SELECT 1 AS x')",
    "SET VARIABLE s = 'SELECT 1'; SELECT * FROM query(getvariable('s'))",
    "SELECT * FROM query_table('concept')",
])
def test_a_pipeline_script_never_runs_sql_built_from_text(managed_db, sql):
    """Whatever is attached: the guard cannot see what the text will run."""
    with pytest.raises(ValueError, match="regenerate it from the pipeline's Vocabulary tab"):
        db_connect.run_etl_sql(managed_db, sql)


@pytest.fixture
def cdm_target(tmp_path):
    path = tmp_path / "cdm.duckdb"
    con = duckdb.connect(str(path))
    con.execute("CREATE TABLE person(person_id BIGINT, gender_concept_id INTEGER, race_source_concept_id BIGINT)")
    con.execute("INSERT INTO person VALUES (1, 8507, 0), (2, 8532, NULL)")
    con.execute("CREATE TABLE \"odd \"\"name'\"(unit_concept_id VARCHAR, note VARCHAR)")
    con.execute("INSERT INTO \"odd \"\"name'\" VALUES ('9529', 'x'), ('not a number', 'y')")
    con.execute("CREATE SCHEMA staging")
    con.execute("CREATE TABLE staging.visit(visit_concept_id BIGINT)")
    con.execute("INSERT INTO staging.visit VALUES (9201)")
    con.execute("CREATE TABLE concept(concept_id BIGINT, domain_concept_id BIGINT)")
    con.execute("INSERT INTO concept VALUES (1, 42)")
    con.close()
    yield str(path)
    connection_pool.clear()


def test_the_run_provides_every_concept_id_column_of_the_target(cdm_target):
    rows = db_connect.run_etl_sql(
        cdm_target,
        f"SELECT table_name, concept_id FROM {db_connect.TARGET_CONCEPT_IDS_VIEW} ORDER BY ALL",
    )
    assert rows == [
        {"table_name": "concept", "concept_id": 42},
        {"table_name": "odd \"name'", "concept_id": 9529},
        {"table_name": "odd \"name'", "concept_id": None},
        {"table_name": "person", "concept_id": 0},
        {"table_name": "person", "concept_id": 8507},
        {"table_name": "person", "concept_id": 8532},
        {"table_name": "person", "concept_id": None},
        {"table_name": "visit", "concept_id": 9201},
    ]


def test_the_used_concept_step_of_the_fill_script_runs_on_the_server(cdm_target):
    """Step 1 of buildFillVocabularyScript, as generated."""
    rows = db_connect.run_etl_sql(
        cdm_target,
        f"""
        CREATE OR REPLACE TABLE target.tmp_used_concepts AS
        SELECT DISTINCT concept_id
        FROM {db_connect.TARGET_CONCEPT_IDS_VIEW}
        WHERE table_name NOT IN ('concept', 'concept_ancestor', 'concept_class', 'concept_relationship', 'concept_synonym', 'domain', 'drug_strength', 'relationship', 'vocabulary', 'source_to_concept_map')
          AND table_name NOT SIMILAR TO 'tmp_.*'
          AND concept_id IS NOT NULL AND concept_id <> 0;
        SELECT concept_id FROM target.tmp_used_concepts ORDER BY 1;
        """,
    )
    assert rows == [{"concept_id": 8507}, {"concept_id": 8532}, {"concept_id": 9201}, {"concept_id": 9529}]


def test_a_target_without_concept_columns_scans_nothing(managed_db):
    con = duckdb.connect(managed_db)
    con.execute("DROP TABLE concept")
    con.close()
    rows = db_connect.run_etl_sql(managed_db, f"SELECT count(*) AS n FROM {db_connect.TARGET_CONCEPT_IDS_VIEW}")
    assert rows == [{"n": 0}]
