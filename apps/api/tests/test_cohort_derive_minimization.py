"""What a derivation keeps beyond the cohort's level (app/services/data/cohort_derive.py):
a wider scope, the tables and variables chosen, birth dates to a precision, and
ids replaced by pseudonyms — consistently across tables, never copied as they are."""

import datetime
import json
import os
from dataclasses import replace

import duckdb
import pyarrow as pa
import pytest

from app.services.data import cohort_derive, db_connect
from app.services.data.cohort_derive import Minimization, Pseudonyms, SourceSpec, TargetSpec

MAPPING = {
    "patientTable": {"table": "person", "idColumn": "person_id"},
    "visitTable": {"table": "visit_occurrence", "idColumn": "visit_occurrence_id", "patientIdColumn": "person_id"},
    "visitDetailTable": {
        "table": "visit_detail", "idColumn": "visit_detail_id",
        "visitIdColumn": "visit_occurrence_id", "patientIdColumn": "person_id",
    },
    "eventTables": {"Measurement": {"table": "measurement", "patientIdColumn": "person_id"}},
}

KEY = b"k" * 32


@pytest.fixture
def source(tmp_path):
    path = tmp_path / "source.duckdb"
    con = duckdb.connect(str(path))
    con.execute(
        "CREATE TABLE person AS SELECT i AS person_id, TIMESTAMP '1980-06-17 08:30:00' AS birth_datetime, "
        "6 AS month_of_birth, 17 AS day_of_birth FROM range(1, 11) t(i)"
    )
    # Two stays per patient, two unit stays per stay.
    con.execute("CREATE TABLE visit_occurrence AS SELECT i AS visit_occurrence_id, 1 + (i - 1) // 2 AS person_id FROM range(1, 21) t(i)")
    con.execute("CREATE TABLE visit_detail AS SELECT i AS visit_detail_id, 1 + (i - 1) // 2 AS visit_occurrence_id, 1 + (i - 1) // 4 AS person_id FROM range(1, 41) t(i)")
    # Two measurements per unit stay: concept 100 and concept 200.
    con.execute(
        "CREATE TABLE measurement AS SELECT row_number() OVER () AS measurement_id, person_id, visit_occurrence_id, "
        "visit_detail_id, c AS measurement_concept_id, c + 1 AS measurement_source_concept_id "
        "FROM visit_detail, (VALUES (100), (200)) v(c)"
    )
    # Carries a stay id only: filtered on the stays, never copied whole.
    con.execute("CREATE TABLE stay_note AS SELECT visit_occurrence_id, 'n' AS txt FROM visit_occurrence")
    con.execute("CREATE TABLE concept AS SELECT i AS concept_id FROM range(1, 6) t(i)")
    con.close()
    return SourceSpec({"kind": "file", "engine": "duckdb", "path": str(path)})


def _query(path, sql):
    con = duckdb.connect(str(path), read_only=True)
    try:
        return con.execute(sql).fetchall()
    finally:
        con.close()


def _count(path, table):
    return _query(path, f'SELECT COUNT(*) FROM "{table}"')[0][0]


def _unit_stays_1_and_2(source):
    return cohort_derive.compute_members(
        source, "SELECT visit_detail_id AS id, person_id AS patient_id FROM visit_detail WHERE visit_detail_id <= 2",
    )


def _derive(source, tmp_path, members, level, name="derived.duckdb", **kw):
    out = tmp_path / name
    written = cohort_derive.derive(
        source, TargetSpec("file", path=str(out), fresh_file=True), members, MAPPING, level, True, **kw,
    )
    return out, {w["table"]: w for w in written}


def test_a_wider_scope_keeps_every_stay_of_the_cohorts_patients(source, tmp_path):
    out, written = _derive(source, tmp_path, _unit_stays_1_and_2(source), "visit_detail", minimization=Minimization(scope="patient"))
    assert written["person"]["rows"] == 1
    assert written["visit_occurrence"]["rows"] == 2
    assert written["visit_detail"]["rows"] == 4
    assert written["measurement"]["rows"] == 8
    assert written["stay_note"]["filter"] == "visit" and written["stay_note"]["rows"] == 2


def test_the_stay_scope_keeps_every_unit_stay_of_the_cohorts_stays(source, tmp_path):
    members = cohort_derive.compute_members(source, "SELECT visit_detail_id AS id, person_id AS patient_id FROM visit_detail WHERE visit_detail_id = 1")
    out, written = _derive(source, tmp_path, members, "visit_detail", minimization=Minimization(scope="visit"))
    assert written["visit_occurrence"]["rows"] == 1
    assert written["visit_detail"]["filter"] == "visit" and written["visit_detail"]["rows"] == 2
    assert written["measurement"]["rows"] == 4


def test_the_scope_is_never_finer_than_the_cohort():
    assert cohort_derive.check_scope("visit", None) == "visit"
    assert cohort_derive.check_scope("visit_detail", "patient") == "patient"
    with pytest.raises(ValueError):
        cohort_derive.check_scope("visit", "visit_detail")


def test_a_table_with_only_a_stay_id_is_filtered_at_patient_scope(source, tmp_path):
    members = cohort_derive.compute_members(source, "SELECT person_id AS id, person_id AS patient_id FROM person WHERE person_id = 1")
    out, written = _derive(source, tmp_path, members, "patient")
    assert written["stay_note"]["filter"] == "visit" and written["stay_note"]["rows"] == 2


def test_a_table_carrying_an_id_no_kept_set_lists_is_never_copied(source, tmp_path):
    # The stays' patient is an expression: the patients' stays cannot be listed,
    # so a table with only a stay id cannot be filtered at patient scope.
    mapping = {
        "formatVersion": 2,
        "patient": {"from": {"table": "person", "alias": "p"}, "fields": {"patient_id": "p.person_id"}},
        "visit": {"from": {"table": "visit_occurrence", "alias": "v"}, "fields": {"visit_id": "v.visit_occurrence_id", "patient_id": {"expr": "v.person_id + 0"}}},
    }
    plan = {p["table"]: p for p in cohort_derive.plan(source, mapping, "patient")}
    assert plan["stay_note"]["filter"] is None and plan["stay_note"]["unfilterable"] == "visit_occurrence_id"
    members = cohort_derive.compute_members(source, "SELECT person_id AS id, person_id AS patient_id FROM person WHERE person_id = 1")
    out = tmp_path / "derived.duckdb"
    written = {w["table"]: w for w in cohort_derive.derive(
        source, TargetSpec("file", path=str(out), fresh_file=True), members, mapping, "patient", True)}
    assert written["stay_note"]["skipped"] is True and written["stay_note"]["unfilterable"] == "visit_occurrence_id"


def test_the_plan_lists_each_tables_columns_and_its_id_columns(source):
    plan = {p["table"]: p for p in cohort_derive.plan(source, MAPPING, "visit_detail", "patient")}
    assert plan["person"]["columns"] == ["person_id", "birth_datetime", "month_of_birth", "day_of_birth"]
    assert plan["measurement"]["pseudonymized"] == ["person_id", "visit_occurrence_id", "visit_detail_id"]
    assert plan["concept"]["pseudonymized"] == []
    assert plan["visit_occurrence"]["filter"] == "patient"


def test_only_the_chosen_tables_are_copied(source, tmp_path):
    chosen = {(None, "person"), (None, "measurement")}
    out, written = _derive(source, tmp_path, _unit_stays_1_and_2(source), "visit_detail", minimization=Minimization(tables=chosen))
    assert {t for t, w in written.items() if not w["skipped"]} == {"person", "measurement"}
    assert written["concept"]["skipped"] is True


def test_an_event_table_keeps_only_the_variables_asked(source, tmp_path):
    variables = {(None, "measurement"): (["measurement_concept_id", "measurement_source_concept_id"], [100])}
    out, written = _derive(source, tmp_path, _unit_stays_1_and_2(source), "visit_detail", minimization=Minimization(variables=variables))
    assert written["measurement"]["rows"] == 2
    assert _query(out, "SELECT DISTINCT measurement_concept_id FROM measurement") == [(100,)]
    # Matched on the source concept as well.
    variables = {(None, "measurement"): (["measurement_concept_id", "measurement_source_concept_id"], [201])}
    out, written = _derive(source, tmp_path, _unit_stays_1_and_2(source), "visit_detail", name="b.duckdb", minimization=Minimization(variables=variables))
    assert _query(out, "SELECT DISTINCT measurement_concept_id FROM measurement") == [(200,)]


def test_an_event_table_with_none_of_the_variables_is_created_empty(source, tmp_path):
    variables = {(None, "measurement"): (["measurement_concept_id"], [])}
    out, written = _derive(source, tmp_path, _unit_stays_1_and_2(source), "visit_detail", minimization=Minimization(variables=variables))
    assert written["measurement"]["rows"] == 0
    assert [c[0] for c in _query(out, "DESCRIBE measurement")][0] == "measurement_id"


def test_a_variable_column_must_be_one_of_the_table(source, tmp_path):
    variables = {(None, "measurement"): (['x" IS NOT NULL OR "y'], [100])}
    with pytest.raises(ValueError):
        _derive(source, tmp_path, _unit_stays_1_and_2(source), "visit_detail", minimization=Minimization(variables=variables))


def test_birth_dates_are_kept_to_the_precision_asked(source, tmp_path):
    # The day of birth OMOP keeps beside the date goes with it.
    dates = {("main", "person"): {"birth_datetime": "month"}}
    out, _ = _derive(source, tmp_path, _unit_stays_1_and_2(source), "visit_detail", minimization=Minimization(dates=dates))
    row = _query(out, "SELECT birth_datetime, month_of_birth, day_of_birth, typeof(birth_datetime) FROM person")[0]
    assert str(row[0]) == "1980-06-01 00:00:00" and row[1] == 6 and row[2] is None and row[3] == "TIMESTAMP"
    dates = {(None, "person"): {"birth_datetime": "year"}}
    out, _ = _derive(source, tmp_path, _unit_stays_1_and_2(source), "visit_detail", name="y.duckdb", minimization=Minimization(dates=dates))
    assert _query(out, "SELECT CAST(birth_datetime AS DATE), month_of_birth FROM person") == [(datetime.date(1980, 1, 1), None)]
    with pytest.raises(ValueError):
        cohort_derive.derive(
            source, TargetSpec("file", path=str(tmp_path / "z.duckdb"), fresh_file=True), _unit_stays_1_and_2(source),
            MAPPING, "visit_detail", True, minimization=Minimization(dates={(None, "person"): {"birth_datetime": "day; DROP"}}),
        )


def _patient_scope(source, tmp_path, name, pseudonyms):
    members = cohort_derive.compute_members(source, "SELECT person_id AS id, person_id AS patient_id FROM person WHERE person_id <= 3")
    return _derive(source, tmp_path, members, "patient", name=name, pseudonyms=pseudonyms)


def test_pseudonyms_replace_every_id_and_still_join(source, tmp_path):
    out, written = _patient_scope(source, tmp_path, "p.duckdb", Pseudonyms("hmac", KEY))
    persons = {r[0] for r in _query(out, "SELECT person_id FROM person")}
    assert len(persons) == 3 and not persons & {1, 2, 3}
    assert all(p > 1000 for p in persons)
    visits = {r[0] for r in _query(out, "SELECT visit_occurrence_id FROM visit_occurrence")}
    assert not visits & set(range(1, 21))
    # Every table carries the same pseudonyms: the joins still hold.
    assert _query(out, "SELECT COUNT(*) FROM measurement m JOIN visit_detail d USING (visit_detail_id) JOIN visit_occurrence v ON v.visit_occurrence_id = d.visit_occurrence_id JOIN person p ON p.person_id = v.person_id") == [(24,)]
    assert _query(out, "SELECT COUNT(*) FROM stay_note JOIN visit_occurrence USING (visit_occurrence_id)") == [(6,)]
    # Other columns are kept as they are.
    assert _query(out, "SELECT DISTINCT measurement_concept_id FROM measurement ORDER BY 1") == [(100,), (200,)]


def test_one_key_gives_the_same_pseudonyms_and_another_key_others(source, tmp_path):
    a, _ = _patient_scope(source, tmp_path, "a.duckdb", Pseudonyms("hmac", KEY))
    b, _ = _patient_scope(source, tmp_path, "b.duckdb", Pseudonyms("hmac", KEY))
    c, _ = _patient_scope(source, tmp_path, "c.duckdb", Pseudonyms("hmac", b"x" * 32))
    ids = lambda p: sorted(r[0] for r in _query(p, "SELECT person_id FROM person"))
    assert ids(a) == ids(b) != ids(c)
    r1, _ = _patient_scope(source, tmp_path, "r1.duckdb", Pseudonyms("random"))
    r2, _ = _patient_scope(source, tmp_path, "r2.duckdb", Pseudonyms("random"))
    assert ids(r1) != ids(r2)


def test_the_hmac_pseudonym_is_the_documented_one():
    import hashlib
    import hmac

    expected = int.from_bytes(hmac.new(KEY, b"patient:42", hashlib.sha256).digest()[:8], "big") >> 1
    assert cohort_derive.pseudonyms_for("hmac", KEY, "patient", ["42"]) == [expected]
    with pytest.raises(ValueError):
        cohort_derive.pseudonyms_for("hmac", None, "patient", ["42"])


def test_a_text_id_stays_text(tmp_path):
    path = tmp_path / "s.duckdb"
    con = duckdb.connect(str(path))
    con.execute("CREATE TABLE person AS SELECT 'P' || i AS person_id FROM range(1, 4) t(i)")
    con.close()
    src = SourceSpec({"kind": "file", "engine": "duckdb", "path": str(path)})
    members = cohort_derive.compute_members(src, "SELECT person_id AS id, person_id AS patient_id FROM person")
    out = tmp_path / "d.duckdb"
    cohort_derive.derive(src, TargetSpec("file", path=str(out), fresh_file=True), members,
                         {"patientTable": {"table": "person", "idColumn": "person_id"}}, "patient", True,
                         pseudonyms=Pseudonyms("hmac", KEY))
    rows = _query(out, "SELECT person_id, typeof(person_id) FROM person")
    assert {r[1] for r in rows} == {"VARCHAR"} and not {r[0] for r in rows} & {"P1", "P2", "P3"}


def test_linked_ids_are_pseudonymised_and_source_numbers_emptied(tmp_path):
    path = tmp_path / "s.duckdb"
    con = duckdb.connect(str(path))
    con.execute("CREATE TABLE person AS SELECT i AS person_id, 'MRN' || i AS person_source_value FROM range(1, 4) t(i)")
    con.execute(
        "CREATE TABLE visit_occurrence AS SELECT i AS visit_occurrence_id, 1 + (i - 1) // 2 AS person_id, "
        "CASE WHEN i % 2 = 0 THEN i - 1 END AS preceding_visit_occurrence_id, 'ADM' || i AS visit_source_value "
        "FROM range(1, 7) t(i)"
    )
    con.execute(
        "CREATE TABLE measurement AS SELECT visit_occurrence_id, person_id, 'LAB-' || visit_occurrence_id AS measurement_source_value, "
        "person_id AS provider_person_id FROM visit_occurrence"
    )
    con.close()
    src = SourceSpec({"kind": "file", "engine": "duckdb", "path": str(path)})
    mapping = {
        "patientTable": {"table": "person", "idColumn": "person_id"},
        "visitTable": {"table": "visit_occurrence", "idColumn": "visit_occurrence_id", "patientIdColumn": "person_id"},
    }
    members = cohort_derive.compute_members(src, "SELECT person_id AS id, person_id AS patient_id FROM person")
    out = tmp_path / "d.duckdb"
    cohort_derive.derive(src, TargetSpec("file", path=str(out), fresh_file=True), members, mapping, "patient", True,
                         pseudonyms=Pseudonyms("hmac", KEY))
    assert _query(out, "SELECT DISTINCT person_source_value FROM person") == [(None,)]
    assert _query(out, "SELECT DISTINCT visit_source_value FROM visit_occurrence") == [(None,)]
    # The preceding stay is the kept stay's pseudonym: the link still joins.
    assert _query(out, "SELECT COUNT(*) FROM visit_occurrence v JOIN visit_occurrence p "
                       "ON p.visit_occurrence_id = v.preceding_visit_occurrence_id") == [(3,)]
    assert not {r[0] for r in _query(out, "SELECT preceding_visit_occurrence_id FROM visit_occurrence")} & set(range(1, 7))
    assert not {r[0] for r in _query(out, "SELECT provider_person_id FROM measurement")} & {1, 2, 3}
    # A clinical source code is kept.
    assert _query(out, "SELECT COUNT(*) FROM measurement WHERE measurement_source_value LIKE 'LAB-%'") == [(6,)]


def test_the_plan_lists_linked_ids_as_pseudonymised():
    ids = cohort_derive.id_columns(MAPPING)
    assert cohort_derive.pseudonym_level("preceding_visit_occurrence_id", ids) == "visit"
    assert cohort_derive.pseudonym_level("visit_detail_parent_id", ids) == "visit_detail"
    assert cohort_derive.pseudonym_level("preceding_visit_detail_id", ids) == "visit_detail"
    assert cohort_derive.pseudonym_level("measurement_source_value", ids) is None
    assert cohort_derive.pseudonym_level("provider_id", ids) is None


def test_the_correspondence_goes_to_its_own_database_and_a_rebuild_replaces_its_rows(source, tmp_path):
    corr_path = tmp_path / "corr.duckdb"
    duckdb.connect(str(corr_path)).close()
    pseudo = Pseudonyms(
        "random", correspondence=TargetSpec("file", path=str(corr_path), schema="pseudo"),
        derivation_id="ds1", derivation="Sepsis",
    )
    out, _ = _patient_scope(source, tmp_path, "p.duckdb", pseudo)
    rows = _query(corr_path, "SELECT kind, original_id, pseudonym FROM pseudo.linkr_pseudonyms WHERE kind = 'patient' ORDER BY original_id")
    assert [r[1] for r in rows] == ["1", "2", "3"]
    assert {r[2] for r in rows} == {r[0] for r in _query(out, "SELECT person_id FROM person")}
    assert _query(corr_path, "SELECT kind, COUNT(*) FROM pseudo.linkr_pseudonyms GROUP BY kind ORDER BY kind") == [
        ("patient", 3), ("visit", 6), ("visit_detail", 12),
    ]
    _patient_scope(source, tmp_path, "p2.duckdb", pseudo)
    assert _query(corr_path, "SELECT COUNT(*) FROM pseudo.linkr_pseudonyms") == [(21,)]


# Opt-in live tests: each derives into the database its variable names, as a JSON
# connectionConfig with the password of a login that may write there, e.g.
#   LINKR_TEST_PG_DSN='{"engine":"postgresql","host":"127.0.0.1","port":5432,
#                       "database":"linkr","username":"me","password":"pw-for-tests-only"}'
# SQL Server takes the same keys, Doris also `httpPort` (its Stream Load port).
# Oracle writes into existing schemas only: name two empty ones the login may
# write in, `"derivedSchema"` and `"correspondenceSchema"`. docs/testing.md.
LIVE_DATABASES = {
    "postgresql": "LINKR_TEST_PG_DSN",
    "sqlserver": "LINKR_TEST_MSSQL_DSN",
    "doris": "LINKR_TEST_DORIS_DSN",
    "oracle": "LINKR_TEST_ORACLE_DSN",
}


def _copy_back(config: dict, password: str, schemas: list[str]) -> duckdb.DuckDBPyConnection:
    """What the live database holds in `schemas`, copied into an in-memory DuckDB
    under the same names (lower case), to be read in one dialect."""
    from app.services.data import derive_writers

    out = duckdb.connect()
    con = duckdb.connect()
    con.execute(f"SET extension_directory = '{db_connect._sql_path(db_connect._ext_dir())}'")
    writer = derive_writers.writer_for(con, derive_writers.Destination("external", config=config, password=password), "live")
    try:
        for schema in schemas:
            out.execute(f'CREATE SCHEMA "{schema}"')
            if isinstance(writer, derive_writers.OracleWriter):
                for table in writer._tables(schema.upper()):
                    frame = writer.conn.fetch_df_all(f'SELECT * FROM "{schema.upper()}"."{table}"')
                    data = pa.table(frame).rename_columns([c.lower() for c in pa.table(frame).column_names])
                    out.register("_frame", data)
                    out.execute(f'CREATE TABLE "{schema}"."{table.lower()}" AS SELECT * FROM _frame')
                    out.unregister("_frame")
                continue
            tables = con.execute(
                "SELECT table_name FROM information_schema.tables WHERE table_catalog = 'live' AND table_schema = ?", [schema],
            ).fetchall()
            for (table,) in tables:
                data = con.execute(f'SELECT * FROM live."{schema}"."{table}"').fetch_arrow_table()
                out.register("_frame", data)
                out.execute(f'CREATE TABLE "{schema}"."{str(table).lower()}" AS SELECT * FROM _frame')
                out.unregister("_frame")
    finally:
        writer.close()
        con.close()
    return out


@pytest.mark.parametrize("engine", list(LIVE_DATABASES))
def test_a_pseudonymised_derivation_into_a_live_database(engine, source):
    from app.services.data import derive_writers

    env = LIVE_DATABASES[engine]
    if not os.environ.get(env):
        pytest.skip(f"set {env} to derive into a live {engine} database")
    config = json.loads(os.environ[env])
    assert config.get("engine") == engine
    if engine == "sqlserver":
        # A community extension: never downloaded by the server itself.
        from app.duckdb_extensions import install

        install(db_connect._ext_dir(), community=True)
    password = config.get("password")
    schema = config.pop("derivedSchema", f"cohort_t{os.getpid()}")
    corr_schema = config.pop("correspondenceSchema", f"pseudo_t{os.getpid()}")
    target = TargetSpec("external", config=config, password=password, schema=schema)
    pseudo = Pseudonyms(
        "hmac", KEY,
        correspondence=TargetSpec("external", config=config, password=password, schema=corr_schema),
        derivation_id="live1", derivation="Sepsis",
    )
    members = cohort_derive.compute_members(source, "SELECT person_id AS id, person_id AS patient_id FROM person WHERE person_id <= 3")
    minimization = Minimization(
        variables={(None, "measurement"): (["measurement_concept_id"], [100])},
        dates={(None, "person"): {"birth_datetime": "month"}},
    )
    try:
        written = {w["table"]: w for w in cohort_derive.derive(
            source, target, members, MAPPING, "patient", True, minimization=minimization, pseudonyms=pseudo)}
        assert written["person"]["rows"] == 3 and written["measurement"]["rows"] == 12

        live = _copy_back(config, password, [schema, corr_schema])
        q = lambda sql: live.execute(sql.replace("S.", f'"{schema}".').replace("C.", f'"{corr_schema}".')).fetchall()
        persons = {int(r[0]) for r in q("SELECT person_id FROM S.person")}
        assert len(persons) == 3 and not persons & {1, 2, 3}
        assert q("SELECT COUNT(*) FROM S.measurement m JOIN S.person p ON CAST(p.person_id AS BIGINT) = CAST(m.person_id AS BIGINT)") == [(12,)]
        assert [int(r[0]) for r in q("SELECT DISTINCT measurement_concept_id FROM S.measurement")] == [100]
        assert q("SELECT DISTINCT CAST(birth_datetime AS DATE), day_of_birth FROM S.person") == [(datetime.date(1980, 6, 1), None)]
        corr = q("SELECT original_id, pseudonym FROM C.linkr_pseudonyms WHERE kind = 'patient' ORDER BY original_id")
        assert [r[0] for r in corr] == ["1", "2", "3"] and {int(r[1]) for r in corr} == persons

        # A rebuild into the same schema: the same key, the same pseudonyms, its rows replaced.
        cohort_derive.derive(source, replace(target, replace_schema=True), members, MAPPING, "patient", True,
                             minimization=minimization, pseudonyms=pseudo)
        live = _copy_back(config, password, [schema, corr_schema])
        assert {int(r[0]) for r in q("SELECT person_id FROM S.person")} == persons
        assert q("SELECT COUNT(*) FROM C.linkr_pseudonyms") == [(21,)]
    finally:
        for s in (schema, corr_schema):
            con = duckdb.connect()
            con.execute(f"SET extension_directory = '{db_connect._sql_path(db_connect._ext_dir())}'")
            writer = derive_writers.writer_for(con, derive_writers.Destination("external", config=config, password=password), "live")
            try:
                writer.drop_schema(s)
            finally:
                writer.close()
                con.close()
