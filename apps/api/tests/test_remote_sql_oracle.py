"""DuckDB SQL spelled for Oracle (remote_sql), and the pushdown path that runs it
through Oracle's own driver (pushdown._run_on_oracle). What reaches Oracle must
answer as DuckDB does; anything Oracle reads otherwise stays local."""

import duckdb
import pyarrow as pa
import pytest

from app.services.data import oracle_client, pushdown, remote_sql
from app.services.data.remote_sql import NotPortable, RemoteTable

TABLES = {
    ("main", "measurement"): RemoteTable("CDM", "MEASUREMENT", {
        "person_id": "BIGINT", "measurement_concept_id": "BIGINT", "value_as_number": "DOUBLE",
        "measurement_datetime": "TIMESTAMP", "unit_source_value": "VARCHAR",
    }),
    ("main", "person"): RemoteTable("CDM", "PERSON", {"person_id": "BIGINT", "year_of_birth": "BIGINT"}),
}


def lookup(schema, table):
    return TABLES.get(((schema or "main").lower(), table.lower()))


def oracle(sql: str) -> remote_sql.RemoteQuery:
    return remote_sql.to_remote(sql, "oracle", lookup)


def test_names_are_upper_case_and_quoted_and_limit_is_fetch_first():
    q = oracle("SELECT measurement_concept_id, COUNT(*) AS n FROM measurement GROUP BY 1 ORDER BY n DESC LIMIT 3")
    assert q.sql == (
        'SELECT "MEASUREMENT"."MEASUREMENT_CONCEPT_ID" AS "MEASUREMENT_CONCEPT_ID", COUNT(*) AS "N" '
        'FROM "CDM"."MEASUREMENT" "MEASUREMENT" GROUP BY "MEASUREMENT"."MEASUREMENT_CONCEPT_ID" '
        'ORDER BY "N" DESC NULLS LAST FETCH FIRST 3 ROWS ONLY'
    )
    assert q.columns == ("measurement_concept_id", "n") and q.types == ("BIGINT", "BIGINT")


def test_division_by_zero_is_null_and_integer_division_truncates():
    sql = oracle("SELECT person_id // 2 AS h, person_id % 3 AS m, value_as_number / 4 AS d FROM measurement").sql
    assert 'TRUNC("MEASUREMENT"."PERSON_ID" / NULLIF(2, 0))' in sql
    assert 'MOD("MEASUREMENT"."PERSON_ID", NULLIF(3, 0))' in sql
    assert '"MEASUREMENT"."VALUE_AS_NUMBER" / NULLIF(4, 0)' in sql


def test_dates_are_literals_casts_truncate_and_differences_count_days_or_microseconds():
    sql = oracle(
        "SELECT CAST(measurement_datetime AS DATE) AS d, "
        "DATE_DIFF('day', measurement_datetime, TIMESTAMP '2020-01-02 03:04:05') AS days, "
        "DATE_DIFF('microsecond', measurement_datetime, TIMESTAMP '2020-01-02 03:04:05') AS us "
        "FROM measurement WHERE measurement_datetime >= DATE '2020-01-01' "
        "AND measurement_datetime < CAST(measurement_datetime AS DATE) + INTERVAL 1 DAY"
    ).sql
    assert 'TRUNC("MEASUREMENT"."MEASUREMENT_DATETIME") AS "D"' in sql
    assert "(TRUNC(TIMESTAMP '2020-01-02 03:04:05') - TRUNC(\"MEASUREMENT\".\"MEASUREMENT_DATETIME\"))" in sql
    assert "EXTRACT(SECOND FROM (CAST(TIMESTAMP '2020-01-02 03:04:05' AS TIMESTAMP)" in sql
    assert "DATE '2020-01-01'" in sql and "INTERVAL '1' DAY" in sql


def test_a_timestamp_cast_to_timestamp_is_left_bare_for_the_indexes():
    sql = oracle(
        "SELECT COUNT(*) AS n FROM measurement m JOIN person p ON p.person_id = m.person_id "
        "WHERE CAST(m.measurement_datetime AS TIMESTAMP) >= CAST(CAST(m.measurement_datetime AS DATE) AS TIMESTAMP)"
    ).sql
    assert '"M"."MEASUREMENT_DATETIME" >= CAST(TRUNC("M"."MEASUREMENT_DATETIME") AS TIMESTAMP)' in sql


def test_null_safe_comparisons_booleans_and_blank_nullif():
    q = oracle(
        "SELECT FALSE AS is_drug, NULLIF(CAST(unit_source_value AS VARCHAR), '') AS u FROM measurement "
        "WHERE false OR person_id IS DISTINCT FROM measurement_concept_id"
    )
    assert '0 AS "IS_DRUG"' in q.sql and "1 = 0" in q.sql
    assert 'DECODE("MEASUREMENT"."PERSON_ID", "MEASUREMENT"."MEASUREMENT_CONCEPT_ID", 1, 0) = 0' in q.sql
    assert "NULLIF" not in q.sql and "VARCHAR2(4000)" in q.sql
    assert q.types[0] == "BOOLEAN"


def test_a_null_cast_to_text_is_sent_a_value_of_unknown_type_is_not():
    # The NULL a UNION ALL block puts in a column it lacks.
    q = oracle("SELECT CAST(NULL AS VARCHAR) AS label, COUNT(*) AS n FROM measurement")
    assert "CAST(NULL AS VARCHAR2" in q.sql
    with pytest.raises(NotPortable, match="(?i)to text"):
        oracle("SELECT CAST(value_as_number AS VARCHAR) AS v FROM measurement")


def test_a_select_without_table_reads_dual():
    assert oracle("SELECT 1 AS x").sql == 'SELECT 1 AS "X" FROM DUAL'


def test_scalar_subqueries_beside_aggregates_move_out_with_their_ctes():
    sql = oracle(
        "WITH p AS (SELECT person_id FROM person) "
        "SELECT COUNT(*) AS n, (SELECT COUNT(*) FROM p) AS m FROM measurement"
    ).sql
    assert sql.startswith('WITH "P" AS')
    assert 'FROM (SELECT COUNT(*) AS "N" FROM "CDM"."MEASUREMENT" "MEASUREMENT") "AGGREGATED"' in sql


@pytest.mark.parametrize("sql, reason", [
    ("SELECT unit_source_value || 'x' AS u FROM measurement", "DPipe"),
    ("SELECT COUNT(*) AS n FROM measurement WHERE unit_source_value = ''", "''"),
    ("SELECT EXTRACT(HOUR FROM measurement_datetime) AS h FROM measurement", "EXTRACT"),
    ("SELECT measurement_datetime + INTERVAL 1 MONTH AS m FROM measurement", "interval"),
    ("SELECT DATE_DIFF('month', measurement_datetime, measurement_datetime) AS m FROM measurement", "DATE_DIFF"),
    ("SELECT person_id > 3 AS big FROM measurement", "condition"),
    ("SELECT CAST(value_as_number AS VARCHAR) AS v FROM measurement", "TEXT"),
])
def test_what_oracle_reads_otherwise_stays_local(sql, reason):
    with pytest.raises(NotPortable, match=reason):
        oracle(sql)


def test_a_pushed_down_result_comes_back_under_duckdb_names_and_types(monkeypatch):
    sent = []

    def fetch(config, password, sql, on_cancel=None):
        sent.append(sql)
        return pa.table({"MEASUREMENT_CONCEPT_ID": [3024171.0], "N": [15244.0], "IS_DRUG": [0.0]})

    monkeypatch.setattr(oracle_client, "fetch_arrow", fetch)
    remote = remote_sql.RemoteQuery("SELECT …", ("measurement_concept_id", "n", "is_drug"), ("BIGINT", "BIGINT", "BOOLEAN"))
    con = duckdb.connect()
    rows = pushdown._run_on_oracle(con, {"engine": "oracle"}, "pw", "local sql", remote,
                                   lambda q: con.execute(q).fetchall())
    assert rows == [(3024171, 15244, False)]
    assert sent == ["SELECT …"]


def test_a_statement_oracle_cannot_compile_runs_locally_and_one_that_failed_running_does_not(monkeypatch):
    remote = remote_sql.RemoteQuery("SELECT …", ("x",), ("BIGINT",))
    ran = []

    def refused(*_a, **_k):
        raise oracle_client.OracleQueryFailed("ORA-00904: invalid identifier", "ORA-00904")

    monkeypatch.setattr(oracle_client, "fetch_arrow", refused)
    pushdown._run_on_oracle(duckdb.connect(), {"engine": "oracle"}, "pw", "local sql", remote, ran.append)
    assert ran == ["local sql"]

    def out_of_space(*_a, **_k):
        raise oracle_client.OracleQueryFailed("ORA-01652: unable to extend temp segment", "ORA-01652")

    monkeypatch.setattr(oracle_client, "fetch_arrow", out_of_space)
    with pytest.raises(pushdown.RemoteQueryFailed, match="ORA-01652"):
        pushdown._run_on_oracle(duckdb.connect(), {"engine": "oracle"}, "pw", "local sql", remote, ran.append)


# ── native SQL (the console's "Native Oracle SQL") ───────────────────────────

ORACLE = {"engine": "oracle", "host": "db.example"}


@pytest.mark.parametrize("sql", [
    "select person_id from omop.person",
    "  -- a note\n/* about it */ WITH a AS (SELECT 1 AS x FROM DUAL) SELECT x FROM a;",
    "SELECT /*+ PARALLEL(4) INDEX(m ix) */ COUNT(*) FROM omop.measurement m",
    "SELECT q'[it's; DROP @x INTO]' AS s, 'UTL_HTTP' AS t, \"into\" FROM DUAL",
    "SELECT nq'{a'}' FROM DUAL",
    "SELECT DBMS_LOB.SUBSTR(note_text, 4000, 1) AS t, DBMS_RANDOM.VALUE AS r FROM omop.note",
    "SELECT * FROM omop.person FETCH FIRST 10 ROWS ONLY",
])
def test_native_oracle_sql_accepts_one_plain_select(sql):
    assert pushdown._native_oracle_statement(sql) == sql.strip().rstrip(";")


@pytest.mark.parametrize(("sql", "reason"), [
    ("BEGIN NULL; END;", "single SELECT"),
    ("DELETE FROM omop.person", "single SELECT"),
    ("ALTER SESSION SET current_schema = x", "single SELECT"),
    ("SELECT 1 FROM DUAL; DROP TABLE t", "single statement"),
    ("WITH FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END; SELECT f FROM DUAL", "PL/SQL"),
    ("SELECT * FROM omop.person@prod", "database link"),
    ("SELECT * FROM omop.person FOR UPDATE", "FOR UPDATE"),
    ("SELECT COUNT(*) INTO n FROM omop.person", "INTO"),
    ("SELECT UTL_HTTP.REQUEST('http://x') FROM DUAL", "UTL_HTTP"),
    ("SELECT \"SYS\".\"UTL_INADDR\".GET_HOST_NAME FROM DUAL", "UTL_INADDR"),
    ("SELECT DBMS_XMLGEN.GETXML('SELECT 1 FROM DUAL') FROM DUAL", "DBMS_XMLGEN"),
    ("SELECT HTTPURITYPE('http://x').GETCLOB() FROM DUAL", "HTTPURITYPE"),
    ("SELECT BFILENAME('DIR', 'f') FROM DUAL", "BFILENAME"),
    ("SELECT * FROM XMLTABLE('doc(\"http://x\")')", "XMLTABLE"),
    ("SELECT 1 FROM DUAL /* ; */ ; DROP TABLE t", "single statement"),
    ("SELECT 'unterminated FROM DUAL", "unterminated"),
    ("SELECT q'[unterminated' FROM DUAL", "unterminated"),
])
def test_native_oracle_sql_refuses_what_is_not_one_plain_read(sql, reason):
    with pytest.raises(pushdown.NativeRefused, match=reason):
        pushdown.run_native(duckdb.connect(), ORACLE, None, sql, lambda q: q)


def test_native_oracle_rows_come_back_capped_with_exact_integers(monkeypatch):
    calls = []

    def fetch(config, password, sql, on_cancel=None, max_rows=None, exact=False):
        calls.append((sql, max_rows, exact))
        return pa.table({"PERSON_ID": pa.array([7], pa.int64()), "N": [3.0]})

    monkeypatch.setattr(oracle_client, "fetch_arrow", fetch)
    con = duckdb.connect()
    rows = pushdown.run_native(con, ORACLE, "pw", "SELECT person_id, COUNT(*) n FROM omop.person GROUP BY person_id;",
                               lambda q: con.execute(q).fetchall(), max_rows=100)
    assert rows == [(7, 3.0)]
    assert calls == [("SELECT person_id, COUNT(*) n FROM omop.person GROUP BY person_id", 100, True)]


def test_exact_numbers_are_integers_when_they_fit():
    ids = pa.table({"id": pa.array([1, 2], pa.decimal128(19, 0))})
    assert oracle_client._integers(ids).schema.field("id").type == pa.int64()
    wide = pa.table({"big": pa.array([10**20], pa.decimal128(38, 0)), "price": pa.array([1], pa.decimal128(10, 2))})
    assert oracle_client._integers(wide).schema == wide.schema
