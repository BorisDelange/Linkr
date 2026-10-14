"""remote_sql: which app queries an external database may compute itself, and the
SQL it is sent. A query outside the portable subset must raise NotPortable — the
caller then runs it through the ATTACH, never with another meaning.

Rewrites are checked by reading their output back in DuckDB against the original
where DuckDB can run both; the live comparison against Doris is the manual bench
of docs/planning/doris-plan.md."""

import duckdb
import pytest

from app.services.data.remote_sql import NotPortable, to_remote

TABLES = {
    "measurement": {
        "person_id": "BIGINT", "measurement_concept_id": "INT", "measurement_source_concept_id": "INT",
        "value_as_number": "DOUBLE", "measurement_date": "DATE", "measurement_datetime": "TIMESTAMP",
        "unit_source_value": "VARCHAR", "range_low": "DECIMAL(10,2)",
    },
    "person": {"person_id": "BIGINT", "birth_datetime": "TIMESTAMP", "gender_concept_id": "INT"},
}


def doris(sql: str) -> str:
    return to_remote(sql, "doris", "omop", TABLES.get).sql


def as_duckdb(remote: str) -> str:
    """A Doris translation read back by DuckDB, for the rewrites both can run."""
    return remote.replace("`omop`.", "").replace("`", '"').replace(" <=> ", " IS NOT DISTINCT FROM ")


@pytest.fixture
def con():
    c = duckdb.connect()
    c.execute("CREATE TABLE measurement AS SELECT * FROM (VALUES "
              "(1, 10, 10, NULL, DATE '2020-01-01', TIMESTAMP '2020-01-01 10:00', 'mg', 1.5), "
              "(1, 10, 20, 2.0, DATE '2020-02-01', TIMESTAMP '2020-02-01 11:00', 'g', 2.5), "
              "(2, 30, NULL, 3.0, DATE '2021-03-01', TIMESTAMP '2021-03-01 12:00', NULL, NULL), "
              "(3, NULL, 40, NULL, NULL, NULL, 'mg', 3.5)) "
              "t(person_id, measurement_concept_id, measurement_source_concept_id, value_as_number, "
              "measurement_date, measurement_datetime, unit_source_value, range_low)")
    return c


def same_rows(con, original: str) -> bool:
    remote = as_duckdb(doris(original))
    return sorted(con.execute(original).fetchall(), key=repr) == sorted(con.execute(remote).fetchall(), key=repr)


def test_aggregate_is_translated_and_scoped():
    out = doris('SELECT measurement_concept_id, COUNT(*)::BIGINT AS n FROM "measurement" GROUP BY measurement_concept_id')
    assert "FROM `omop`.`measurement`" in out
    assert "CAST(COUNT(*) AS BIGINT) AS `n`" in out


def test_result_columns_keep_duckdb_names():
    q = to_remote("SELECT m.measurement_concept_id, COUNT(*) AS n FROM measurement m GROUP BY 1", "doris", "omop", TABLES.get)
    assert q.columns == ("measurement_concept_id", "n")


def test_an_unnamed_result_column_is_not_portable():
    with pytest.raises(NotPortable, match="unnamed"):
        doris("SELECT COUNT(*) FROM measurement")


def test_the_attach_prefix_is_dropped():
    assert "FROM `omop`.`measurement`" in doris("SELECT COUNT(*) AS n FROM ext.omop.measurement")


def test_ctes_are_not_scoped_and_not_materialized_is_dropped():
    out = doris("WITH r AS NOT MATERIALIZED (SELECT person_id FROM measurement) SELECT COUNT(*) AS n FROM r")
    assert out.startswith("WITH `r` AS (SELECT")
    assert "FROM `r` AS `r`" in out


def test_filter_becomes_a_case_inside_the_aggregate(con):
    q = ("SELECT COUNT(*) FILTER (WHERE value_as_number IS NULL) AS a, "
         "COUNT(DISTINCT person_id) FILTER (WHERE value_as_number > 1) AS b, "
         "SUM(value_as_number) FILTER (WHERE person_id = 1) AS c FROM measurement")
    assert "COUNT(CASE WHEN" in doris(q)
    assert same_rows(con, q)


def test_group_by_all_groups_by_the_non_aggregates(con):
    q = "SELECT person_id, measurement_concept_id + 1 AS c, COUNT(*) AS n FROM measurement GROUP BY ALL"
    assert "GROUP BY `measurement`.`person_id`, `measurement`.`measurement_concept_id` + 1" in doris(q)
    assert same_rows(con, q)


def test_unnest_of_a_pair_becomes_a_union(con):
    q = ("SELECT cid, COUNT(*) AS n FROM (SELECT UNNEST(CASE WHEN e.measurement_source_concept_id IS DISTINCT FROM "
         "e.measurement_concept_id THEN [e.measurement_concept_id, e.measurement_source_concept_id] "
         "ELSE [e.measurement_concept_id] END) AS cid FROM measurement e) x GROUP BY cid")
    assert "UNION ALL" in doris(q)
    assert same_rows(con, q)


def test_class_relation_padding_reads_missing_columns_as_null():
    sql = (
        'SELECT e."measurement_concept_id" AS concept_id, e."unit_id" AS unit '
        'FROM (SELECT * FROM "measurement" UNION ALL BY NAME '
        'SELECT NULL AS "measurement_concept_id", NULL AS "unit_id" WHERE false) e'
    )
    out = doris(sql)
    assert "SELECT `measurement`.`measurement_concept_id` AS `measurement_concept_id`, NULL AS `unit_id`" in out
    assert "UNION" not in out


def test_padding_of_an_unknown_table_is_not_portable():
    with pytest.raises(NotPortable):
        doris('SELECT e.x AS x FROM (SELECT * FROM "nope" UNION ALL BY NAME SELECT NULL AS "x" WHERE false) e')


def test_text_cast_of_an_integer_or_a_date_is_portable():
    assert "CAST(`measurement`.`person_id` AS STRING)" in doris("SELECT CAST(person_id AS VARCHAR) AS p FROM measurement")
    doris("SELECT CAST(measurement_date AS VARCHAR) AS d FROM measurement")


@pytest.mark.parametrize("expr", ["value_as_number", "measurement_datetime", "range_low"])
def test_text_cast_of_what_engines_print_differently_is_not(expr):
    with pytest.raises(NotPortable, match="CAST"):
        doris(f"SELECT CAST({expr} AS VARCHAR) AS t FROM measurement")


def test_dates_extract_and_differ_the_same_way():
    out = doris("SELECT DATE_PART('year', measurement_datetime) AS y, DATE_DIFF('day', measurement_date, measurement_datetime) AS d, "
                "measurement_date + INTERVAL '60' DAYS AS later FROM measurement")
    assert "EXTRACT(YEAR FROM" in out and "DATEDIFF(" in out and "INTERVAL '60' DAY" in out


def test_age_in_years_becomes_timestampdiff():
    out = doris("SELECT EXTRACT(YEAR FROM AGE(m.measurement_datetime, p.birth_datetime)) AS age "
                "FROM measurement m JOIN person p ON p.person_id = m.person_id")
    assert "TIMESTAMPDIFF(YEAR, `p`.`birth_datetime`, `m`.`measurement_datetime`)" in out


def test_catalog_patient_key_is_spelled_from_md5():
    """md5_number_lower reads the digest's last 8 bytes little-endian; mod 2^32
    keeps bytes 8..11 — hex 17..24 reversed — as DuckDB would compute."""
    out = doris("SELECT SUM(md5_number_lower('d' || CAST(person_id AS VARCHAR)) % 4294967296) AS k FROM measurement")
    assert "CONV(CONCAT(SUBSTRING(MD5(CONCAT('d', CAST(`measurement`.`person_id` AS STRING))), 23, 2)" in out
    con = duckdb.connect()
    for value in ("d1", "salt-42", "x" * 40):
        key = con.execute(f"SELECT md5_number_lower('{value}') % 4294967296").fetchone()[0]
        digest = con.execute(f"SELECT md5('{value}')").fetchone()[0]
        assert key == int("".join(digest[i - 1:i + 1] for i in (23, 21, 19, 17)), 16)


def test_percentiles_of_numbers_use_doris_percentile():
    out = doris("SELECT MEDIAN(value_as_number) AS m, QUANTILE_CONT(value_as_number, 0.25) AS q, "
                "PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY person_id) AS p FROM measurement")
    assert "PERCENTILE(`measurement`.`value_as_number`, 0.5)" in out
    assert "PERCENTILE(`measurement`.`value_as_number`, 0.25)" in out
    assert "PERCENTILE(`measurement`.`person_id`, 0.9)" in out


def test_percentile_of_a_decimal_is_not_portable():
    with pytest.raises(NotPortable):
        doris("SELECT MEDIAN(range_low) AS m FROM measurement")


@pytest.mark.parametrize("sql", [
    "SELECT * FROM read_parquet('/etc/passwd')",
    "SELECT mode(unit_source_value) AS m FROM measurement",
    "SELECT COUNT(DISTINCT (person_id, measurement_concept_id)) AS n FROM measurement",
    "SELECT SUM(value_as_number) OVER (ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS s FROM measurement",
    "SELECT STRFTIME(measurement_date, '%M') AS m FROM measurement",
    "SELECT EPOCH(measurement_datetime) AS e FROM measurement",
    "SELECT person_id AS p FROM measurement UNION ALL BY NAME SELECT person_id AS p FROM person",
    "SELECT n FROM memory.main.counts",
    "SELECT person_id AS p FROM other.measurement",
    "SELECT unit_source_value AS u FROM measurement WHERE unit_source_value LIKE 'm%'",
    "SELECT nope AS n FROM measurement",
    "SELECT 1 AS a; SELECT 2 AS b",
    "INSERT INTO measurement VALUES (1)",
    "CALL mysql_execute('ext', 'DROP TABLE measurement')",
    "COPY (SELECT 1) TO '/tmp/x.csv'",
    "not sql at all (",
])
def test_outside_the_portable_subset(sql):
    with pytest.raises(NotPortable):
        doris(sql)


def test_mysql_is_not_translated():
    """MySQL compares text case-insensitively by default: not the same answer."""
    with pytest.raises(NotPortable):
        to_remote("SELECT COUNT(*) AS n FROM measurement", "mysql", "omop", TABLES.get)


def test_postgres_has_no_spelling_of_duckdb_functions():
    with pytest.raises(NotPortable):
        to_remote("SELECT MEDIAN(value_as_number) AS m FROM measurement", "postgresql", "cdm", TABLES.get)
