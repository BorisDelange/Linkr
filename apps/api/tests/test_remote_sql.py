"""remote_sql: which app queries an external database may compute itself, and the
SQL it is sent. A query outside the portable subset must raise NotPortable — the
caller then runs it through the ATTACH, never with another meaning.

Rewrites are checked by reading their output back in DuckDB against the original
where DuckDB can run both; the live comparison against Doris is the manual bench
of docs/planning/doris-plan.md."""

import duckdb
import pytest

from app.services.data.remote_sql import NotPortable, RemoteTable, to_remote

TABLES = {
    "measurement": {
        "person_id": "BIGINT", "measurement_concept_id": "INT", "measurement_source_concept_id": "INT",
        "value_as_number": "DOUBLE", "measurement_date": "DATE", "measurement_datetime": "TIMESTAMP",
        "unit_source_value": "VARCHAR", "range_low": "DECIMAL(10,2)",
    },
    "person": {"person_id": "BIGINT", "birth_datetime": "TIMESTAMP", "gender_concept_id": "INT"},
}




def lookup(schema: str | None, table: str) -> RemoteTable | None:
    """The tables above, in the default schema `omop`."""
    cols = TABLES.get(table.lower()) if (schema or "omop").lower() == "omop" else None
    return RemoteTable("omop", table.lower(), cols) if cols else None


def doris(sql: str) -> str:
    return to_remote(sql, "doris", lookup).sql


def as_duckdb(remote: str) -> str:
    """A Doris translation read back by DuckDB, for the rewrites both can run."""
    return (remote.replace("`omop`.", "").replace("`", '"').replace(" <=> ", " IS NOT DISTINCT FROM ")
            .replace(" DIV ", " // "))


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
    q = to_remote("SELECT m.measurement_concept_id, COUNT(*) AS n FROM measurement m GROUP BY 1", "doris", lookup)
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


def test_hand_written_relation_padding_reads_the_columns_its_sql_names(con):
    sql = (
        'SELECT e."unit" AS unit, e."route" AS route '
        'FROM (SELECT * FROM (SELECT unit_source_value AS unit, person_id FROM measurement) _src '
        'UNION ALL BY NAME SELECT NULL AS "unit", NULL AS "route" WHERE false) e'
    )
    out = doris(sql)
    assert "UNION" not in out
    assert "NULL AS `route`" in out
    assert same_rows(con, sql)


def test_a_hand_written_relation_selecting_a_star_is_not_unpadded():
    with pytest.raises(NotPortable, match="result columns"):
        doris('SELECT e."unit" AS unit FROM (SELECT * FROM (SELECT * FROM measurement) _src '
              'UNION ALL BY NAME SELECT NULL AS "unit" WHERE false) e')


def test_a_hand_written_relation_selecting_a_qualified_star_is_not_unpadded():
    """`p.*` names no column one by one: read as present, every padding column
    would be rewritten as NULL."""
    with pytest.raises(NotPortable, match="result columns"):
        doris('SELECT e.person_id AS p FROM (SELECT * FROM (SELECT p.* FROM person p) _src '
              'UNION ALL BY NAME SELECT NULL AS "person_id" WHERE false) e')


@pytest.mark.parametrize("sql", [
    "SELECT COUNT(*) AS n FROM measurement WHERE unit_source_value LIKE 'm%'",
    "SELECT COUNT(*) AS n FROM measurement WHERE unit_source_value NOT LIKE '_g'",
    "SELECT COUNT(*) AS n FROM measurement WHERE LOWER(unit_source_value) = 'mg' OR UPPER(unit_source_value) = 'G'",
])
def test_like_and_case_folding_of_text_are_portable(con, sql):
    # Both engines match case-sensitively; only a backslash differs (an escape in Doris).
    assert same_rows(con, sql)


def test_padding_of_an_unknown_table_is_not_portable():
    with pytest.raises(NotPortable):
        doris('SELECT e.x AS x FROM (SELECT * FROM "nope" UNION ALL BY NAME SELECT NULL AS "x" WHERE false) e')


def test_a_typed_null_is_portable(con):
    # The concept list's counts, before any count: NULL::BIGINT, the same everywhere.
    assert "CAST(NULL AS BIGINT)" in doris("SELECT CAST(NULL AS BIGINT) AS n FROM measurement")
    assert same_rows(con, "SELECT person_id, CAST(NULL AS BIGINT) AS n FROM measurement")


def test_text_cast_of_an_integer_or_a_date_is_portable():
    assert "CAST(`measurement`.`person_id` AS STRING)" in doris("SELECT CAST(person_id AS VARCHAR) AS p FROM measurement")
    doris("SELECT CAST(measurement_date AS VARCHAR) AS d FROM measurement")


@pytest.mark.parametrize("expr", ["value_as_number", "measurement_datetime", "range_low"])
def test_text_cast_of_what_engines_print_differently_is_not(expr):
    with pytest.raises(NotPortable, match="CAST"):
        doris(f"SELECT CAST({expr} AS VARCHAR) AS t FROM measurement")


def test_an_iso_date_literal_is_portable(con):
    """`DATE '2020-01-01'` is a cast of a string literal: the one spelling every
    engine reads alike."""
    q = "SELECT COUNT(*) AS n FROM measurement WHERE measurement_date >= DATE '2020-02-01' AND measurement_datetime < TIMESTAMP '2021-01-01 00:00:00'"
    assert "CAST('2020-02-01' AS DATE)" in doris(q) and "CAST('2021-01-01 00:00:00' AS DATETIME(6))" in doris(q)
    assert same_rows(con, q)
    assert same_rows(con, "SELECT person_id AS p FROM measurement WHERE measurement_date = CAST('2020-01-01' AS DATE)")


@pytest.mark.parametrize(("duckdb_type", "doris_type"), [
    ("TIMESTAMP", "DATETIME(6)"), ("DATETIME", "DATETIME(6)"), ("TIMESTAMP_MS", "DATETIME(3)"),
    ("TIMESTAMP_S", "DATETIME(0)"), ("TIMESTAMP_NS", "DATETIME(6)"),
])
def test_a_timestamp_keeps_its_precision_on_doris(duckdb_type, doris_type):
    """Doris' bare DATETIME is DATETIME(0): it would drop DuckDB's microseconds."""
    out = doris(f"SELECT CAST(measurement_date AS {duckdb_type}) AS t FROM measurement")
    assert f"AS {doris_type})" in out


def test_a_timestamp_literal_keeps_its_sub_seconds(con):
    q = "SELECT COUNT(*) AS n FROM measurement WHERE measurement_datetime > TIMESTAMP '2020-01-01 10:00:00.5'"
    assert "CAST('2020-01-01 10:00:00.5' AS DATETIME(6))" in doris(q)
    assert same_rows(con, q)


@pytest.mark.parametrize("literal", ["DATE 'epoch'", "DATE '2020-1-5'", "TIMESTAMP '2020-01-01T10:00:00'", "CAST(unit_source_value AS DATE)"])
def test_a_date_spelling_duckdb_alone_reads_is_not(literal):
    with pytest.raises(NotPortable, match="CAST"):
        doris(f"SELECT COUNT(*) AS n FROM measurement WHERE measurement_date >= {literal}")


def test_dates_extract_and_differ_the_same_way():
    out = doris("SELECT DATE_PART('year', measurement_datetime) AS y, DATE_DIFF('day', measurement_date, measurement_datetime) AS d, "
                "measurement_date + INTERVAL '60' DAYS AS later FROM measurement")
    assert "EXTRACT(YEAR FROM" in out and "DATEDIFF(" in out and "INTERVAL '60' DAY" in out


def test_a_time_becomes_a_number_through_an_exact_microsecond_difference():
    """DuckDB's EPOCH reads a naive timestamp as UTC, Doris' UNIX_TIMESTAMP in the
    session's zone: the overview's buckets count microseconds from a literal."""
    out = doris("SELECT DATE_DIFF('microsecond', TIMESTAMP '1970-01-01 00:00:00', measurement_datetime) // 3600000000 AS h "
                "FROM measurement")
    assert "MICROSECONDS_DIFF(`measurement`.`measurement_datetime`, CAST('1970-01-01 00:00:00' AS DATETIME(6))) DIV 3600000000" in out


def test_integer_division_reads_back_alike(con):
    assert same_rows(con, "SELECT person_id // 2 AS a, (-person_id) // 2 AS b, person_id // 0 AS c FROM measurement")


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


def test_approximate_quantiles_use_doris_percentile_approx():
    out = doris("SELECT APPROX_QUANTILE(value_as_number, 0.99) AS p FROM measurement")
    assert "PERCENTILE_APPROX(`measurement`.`value_as_number`, 0.99)" in out


@pytest.mark.parametrize("sql", [
    "SELECT APPROX_QUANTILE(range_low, 0.5) AS p FROM measurement",
    "SELECT APPROX_QUANTILE(value_as_number, person_id) AS p FROM measurement",
    "SELECT APPROX_QUANTILE(value_as_number, [0.25, 0.75]) AS p FROM measurement",
])
def test_an_approximate_quantile_outside_one_fraction_of_a_number_is_not_portable(sql):
    with pytest.raises(NotPortable):
        doris(sql)


def test_an_approximate_quantile_has_no_postgres_spelling():
    with pytest.raises(NotPortable):
        to_remote("SELECT APPROX_QUANTILE(value_as_number, 0.5) AS p FROM measurement", "postgresql", lookup)


def test_sample_standard_deviation_keeps_its_name(con):
    # Doris' bare STDDEV is the population one: only the sample one is admitted.
    sql = "SELECT STDDEV_SAMP(value_as_number) AS s FROM measurement"
    assert "STDDEV_SAMP(`measurement`.`value_as_number`)" in doris(sql)
    assert same_rows(con, sql)
    with pytest.raises(NotPortable):
        doris("SELECT STDDEV(value_as_number) AS s FROM measurement")


def test_floor_is_portable_once_cast_to_an_integer(con):
    sql = "SELECT CAST(FLOOR(value_as_number / 2.0) AS BIGINT) AS b FROM measurement"
    assert same_rows(con, sql)
    with pytest.raises(NotPortable):
        doris("SELECT FLOOR(value_as_number) AS b FROM measurement")


def test_a_parenthesised_hand_written_relation_reads_the_columns_its_sql_names():
    out = doris('SELECT e."person_id" AS p, e."route" AS r FROM (SELECT * FROM ((SELECT person_id FROM person)) _src '
                'UNION ALL BY NAME SELECT NULL AS "person_id", NULL AS "route" WHERE false) e')
    assert "`_src`.`person_id` AS `person_id`, NULL AS `route`" in out


@pytest.mark.parametrize("sql", [
    "SELECT * FROM read_parquet('/etc/passwd')",
    "SELECT mode(unit_source_value) AS m FROM measurement",
    "SELECT COUNT(DISTINCT (person_id, measurement_concept_id)) AS n FROM measurement",
    "SELECT SUM(value_as_number) OVER (ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS s FROM measurement",
    "SELECT STRFTIME(measurement_datetime, '%B') AS m FROM measurement",
    "SELECT STRING_AGG(DISTINCT unit_source_value, ',') AS u FROM measurement",
    "SELECT STRING_AGG(person_id, ',') AS u FROM measurement",
    "SELECT CONCAT_WS(',', unit_source_value, person_id) AS u FROM measurement",
    "SELECT CHR(233) AS c FROM measurement",
    "SELECT SUBSTR(unit_source_value, 0) AS u FROM measurement",
    "SELECT SUBSTR(unit_source_value, person_id) AS u FROM measurement",
    "SELECT * FROM (VALUES (person_id)) v(p)",
    "WITH s(code) AS (VALUES ('a'), ('b') LIMIT 1) SELECT code AS c FROM s",
    "WITH s(code) AS (VALUES ('a'), ('b') OFFSET 1) SELECT code AS c FROM s",
    "SELECT STRING_AGG(unit_source_value, ',') OVER (PARTITION BY person_id) AS u FROM measurement",
    "SELECT EPOCH(measurement_datetime) AS e FROM measurement",
    "SELECT DATE_DIFF('second', measurement_date, measurement_datetime) AS d FROM measurement",
    "SELECT value_as_number // 2 AS h FROM measurement",
    "SELECT person_id AS p FROM measurement UNION ALL BY NAME SELECT person_id AS p FROM person",
    "SELECT n FROM memory.main.counts",
    "SELECT person_id AS p FROM other.measurement",
    "SELECT unit_source_value AS u FROM measurement WHERE unit_source_value LIKE 'm\\_%'",
    "SELECT unit_source_value AS u FROM measurement WHERE unit_source_value LIKE 'm!_%' ESCAPE '!'",
    "SELECT unit_source_value AS u FROM measurement WHERE unit_source_value LIKE unit_source_value",
    "SELECT unit_source_value AS u FROM measurement WHERE unit_source_value ILIKE 'M%'",
    "SELECT person_id AS p FROM measurement WHERE person_id LIKE '1%'",
    "SELECT LOWER(person_id) AS p FROM measurement",
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


# --- What reaches the passthrough: escaping and the scope ---------------------
#
# The remote SQL is interpolated into a single-quoted literal by the caller
# (db_connect._passthrough doubles the quotes), so what matters here is that
# sqlglot re-emits a literal as a literal and an identifier as an identifier,
# and that nothing outside the scope's tables gets through.


@pytest.mark.parametrize("sql, expected", [
    ("SELECT COUNT(*) AS n FROM measurement WHERE unit_source_value = 'O''Brien'", "= 'O''Brien'"),
    ("SELECT COUNT(*) AS n FROM measurement WHERE unit_source_value = 'a\\b'", "= 'a\\\\b'"),
    ("SELECT COUNT(*) AS n FROM measurement WHERE unit_source_value = 'x''; DROP TABLE measurement; --'", "= 'x''; DROP TABLE measurement; --'"),
    ("SELECT COUNT(*) AS n FROM measurement WHERE unit_source_value = 'a\nb'", "= 'a\\nb'"),
    ('SELECT "person_id" AS "p`q" FROM measurement', "AS `p``q`"),
    ("SELECT COUNT(*) AS n FROM measurement -- comment */ here\nWHERE person_id = 1", "/* comment * / here */ WHERE"),
])
def test_literals_and_identifiers_are_re_escaped_for_doris(sql, expected):
    assert expected in doris(sql)


@pytest.mark.parametrize("sql, reason", [
    ("SELECT COUNT(*) AS n FROM measurement WHERE unit_source_value = 'x'; DROP TABLE measurement", "single SELECT"),
    ("SELECT table_name AS t FROM information_schema.tables", "unknown table information_schema.tables"),
    ("SELECT COUNT(*) AS n FROM mysql.user", "unknown table mysql.user"),
    ("SELECT n FROM memory.main.counts", "catalog memory"),
    ("SELECT x AS x FROM read_parquet('/etc/passwd') t(x)", "table function"),
    ("SELECT x AS x FROM mysql_execute('ext', 'DROP TABLE t') t(x)", "table function"),
    ("SELECT x AS x FROM mysql_query('ext', 'SELECT 1') t(x)", "table function"),
    ("SELECT COUNT(*) AS n FROM measurement WHERE unit_source_value = E'a\\nb'", "ByteString"),
    ("SELECT COUNT(*) AS n FROM measurement WHERE unit_source_value = $$x'y$$", "RawString"),
    ("SELECT current_user() AS u FROM measurement", "CurrentUser"),
    ("SELECT sleep(10) AS s FROM measurement", "function sleep"),
    ("SELECT COUNT(*) AS n FROM measurement WHERE unit_source_value = 'x' INTO OUTFILE '/tmp/x'", "unparsed"),
])
def test_outside_the_scope_or_the_grammar(sql, reason):
    with pytest.raises(NotPortable, match=reason):
        doris(sql)


CATALOGUE = {
    ("core", "patient"): RemoteTable("CORE", "Patient", {"patient_id": "BIGINT", "gender": "VARCHAR"}),
    ("vocab", "concept"): RemoteTable("VOCAB", "concept", {"concept_code": "VARCHAR", "label": "VARCHAR"}),
    ("core", "event"): RemoteTable("CORE", "event", {"patient_id": "BIGINT", "concept_code": "VARCHAR"}),
}


def several_schemas(default: str | None):
    def lookup(schema: str | None, table: str) -> RemoteTable | None:
        schema = schema or default
        return CATALOGUE.get((schema.lower(), table.lower())) if schema else None
    return lookup


def test_a_join_across_schemas_names_each_table_in_its_own_schema():
    out = to_remote(
        "SELECT c.label, COUNT(*) AS n FROM event e JOIN vocab.concept c ON c.concept_code = e.concept_code GROUP BY c.label",
        "doris", several_schemas("core"),
    ).sql
    assert "FROM `CORE`.`event`" in out
    assert "JOIN `VOCAB`.`concept`" in out


def test_the_remote_spelling_of_a_name_is_put_back():
    out = to_remote("SELECT COUNT(*) AS n FROM ext.core.patient", "doris", several_schemas(None)).sql
    assert "FROM `CORE`.`Patient`" in out


def test_a_bare_name_without_a_default_schema_stays_local():
    with pytest.raises(NotPortable, match="unknown table patient"):
        to_remote("SELECT COUNT(*) AS n FROM patient", "doris", several_schemas(None))


def test_mysql_is_not_translated():
    """MySQL compares text case-insensitively by default: not the same answer."""
    with pytest.raises(NotPortable):
        to_remote("SELECT COUNT(*) AS n FROM measurement", "mysql", lookup)


def test_postgres_has_no_spelling_of_duckdb_functions():
    with pytest.raises(NotPortable):
        to_remote("SELECT MEDIAN(value_as_number) AS m FROM measurement", "postgresql", lookup)


# --- Text assembly: what a hand-written note relation uses -------------------


def test_string_agg_keeps_its_order_and_separator():
    # sqlglot's own `GROUP_CONCAT(x ORDER BY o, sep)` has Doris drop the separator.
    sql = doris("SELECT person_id, STRING_AGG(unit_source_value, CHR(10) || CHR(10) ORDER BY measurement_date DESC) AS u "
                "FROM measurement GROUP BY person_id")
    assert "ORDER BY `measurement`.`measurement_date` DESC SEPARATOR CONCAT(CHAR(10), CHAR(10)))" in sql


def test_string_agg_without_a_separator_says_duckdbs_comma():
    # Doris' own default is ', '.
    assert "SEPARATOR ',')" in doris("SELECT STRING_AGG(unit_source_value) AS u FROM measurement")


def test_a_filtered_string_agg_reads_its_rows_through_a_case():
    sql = doris("SELECT STRING_AGG(unit_source_value, ',' ORDER BY person_id) FILTER (WHERE person_id > 1) AS u FROM measurement")
    assert "GROUP_CONCAT(CASE WHEN `measurement`.`person_id` > 1 THEN `measurement`.`unit_source_value` END ORDER BY" in sql


def test_text_functions_are_spelled_for_doris():
    sql = doris("SELECT CONCAT_WS('|', unit_source_value, 'x') AS a, LENGTH(unit_source_value) AS b, "
                "STARTS_WITH(unit_source_value, 'm') AS c, SUBSTR(unit_source_value, LENGTH('m:') + 1) AS d, "
                "STRFTIME(measurement_datetime, '%d-%m-%Y %H:%M') AS e FROM measurement")
    for part in ("CONCAT_WS('|'", "CHAR_LENGTH(", "STARTS_WITH(", "SUBSTRING(`measurement`.`unit_source_value`, 3)",
                 "DATE_FORMAT(`measurement`.`measurement_datetime`, '%d-%m-%Y %H:%i')"):
        assert part in sql


def test_a_values_list_becomes_a_union_of_literal_rows():
    sql = doris("WITH s(code, label) AS (VALUES ('mg', 'milligram'), ('g', 'gram')) "
                "SELECT m.person_id AS p, s.label AS l FROM measurement m JOIN s ON s.code = m.unit_source_value")
    assert "VALUES" not in sql
    assert "SELECT 'mg' AS `code`, 'milligram' AS `label` UNION ALL SELECT 'g' AS `code`, 'gram' AS `label`" in sql


def test_a_nested_with_moves_before_the_cte_holding_it():
    sql = doris("WITH a AS (SELECT * FROM (WITH b AS (SELECT person_id FROM measurement) SELECT person_id FROM b) x) "
                "SELECT person_id AS p FROM a")
    assert sql.startswith("WITH `b` AS (")
    assert sql.index("`b` AS (") < sql.index("`a` AS (")
    assert sql.count("WITH") == 1


def test_a_nested_with_reusing_a_name_stays_local():
    with pytest.raises(NotPortable, match="nested WITH"):
        doris("WITH b AS (SELECT person_id FROM person), a AS (SELECT * FROM (WITH b AS (SELECT person_id FROM measurement) "
              "SELECT person_id FROM b) x) SELECT a.person_id AS p FROM a JOIN b ON a.person_id = b.person_id")


def test_exists_is_kept():
    sql = doris("SELECT person_id AS p FROM person WHERE EXISTS (SELECT 1 FROM measurement m WHERE m.person_id = person.person_id)")
    assert "WHERE EXISTS(SELECT 1" in sql


def test_a_nested_with_reading_an_outer_column_stays_local():
    with pytest.raises(NotPortable, match="correlated WITH"):
        doris("SELECT (WITH c AS (SELECT p.person_id AS x) SELECT x FROM c) AS y FROM person p")


def test_a_nested_with_reading_an_outer_column_from_a_subquery_stays_local():
    with pytest.raises(NotPortable, match="correlated WITH"):
        doris("SELECT (WITH c AS (SELECT x FROM (SELECT p.person_id AS x) t) SELECT x FROM c) AS y FROM person p")


def test_a_nested_with_whose_subquery_reads_its_own_outer_scope_moves():
    sql = doris("SELECT y AS p FROM (WITH c AS (SELECT m.person_id FROM measurement m WHERE EXISTS "
                "(SELECT 1 FROM person q WHERE q.person_id = m.person_id)) SELECT person_id AS y FROM c) s")
    assert sql.startswith("WITH `c` AS (") and sql.count("WITH") == 1


def test_a_nested_with_under_exists_reading_an_outer_column_stays_local():
    with pytest.raises(NotPortable, match="correlated WITH"):
        doris("SELECT person_id AS p FROM person WHERE EXISTS (WITH c AS (SELECT m.person_id FROM measurement m "
              "WHERE m.person_id = person.person_id) SELECT 1 FROM c)")
