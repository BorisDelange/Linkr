"""Deriving a database from a cohort (app/services/data/cohort_derive.py):
every table filtered on the cohort at its level, copied self-contained, and the
client's membership SQL never running where it could write."""

import duckdb
import pytest

from app.services.data import cohort_derive
from app.services.data.cohort_derive import SourceSpec, TargetSpec

MAPPING = {
    "patientTable": {"table": "person", "idColumn": "person_id"},
    "visitTable": {"table": "visit_occurrence", "idColumn": "visit_occurrence_id", "patientIdColumn": "person_id"},
    "visitDetailTable": {
        "table": "visit_detail", "idColumn": "visit_detail_id",
        "visitIdColumn": "visit_occurrence_id", "patientIdColumn": "person_id",
    },
    "eventTables": {"Measurement": {"table": "measurement", "patientIdColumn": "person_id"}},
}


@pytest.fixture
def source(tmp_path):
    path = tmp_path / "source.duckdb"
    con = duckdb.connect(str(path))
    con.execute("CREATE TABLE person AS SELECT i AS person_id FROM range(1, 11) t(i)")
    # Two stays per patient, two unit stays per stay.
    con.execute("CREATE TABLE visit_occurrence AS SELECT i AS visit_occurrence_id, 1 + (i - 1) // 2 AS person_id FROM range(1, 21) t(i)")
    con.execute("CREATE TABLE visit_detail AS SELECT i AS visit_detail_id, 1 + (i - 1) // 2 AS visit_occurrence_id, 1 + (i - 1) // 4 AS person_id FROM range(1, 41) t(i)")
    # A measurement per unit stay, carrying the stay and the unit stay.
    con.execute("CREATE TABLE measurement AS SELECT i AS measurement_id, person_id, visit_occurrence_id, visit_detail_id FROM visit_detail, range(1) r(i)")
    con.execute("CREATE TABLE concept AS SELECT i AS concept_id FROM range(1, 6) t(i)")
    con.close()
    return SourceSpec({"kind": "file", "engine": "duckdb", "path": str(path)})


def _rows(path, table, schema="main"):
    con = duckdb.connect(str(path), read_only=True)
    try:
        return con.execute(f'SELECT COUNT(*) FROM "{schema}"."{table}"').fetchone()[0]
    finally:
        con.close()


def test_patient_level_keeps_the_patients_everywhere_and_the_vocabulary_whole(source, tmp_path):
    members = cohort_derive.compute_members(source, "SELECT person_id AS id, person_id AS patient_id FROM person WHERE person_id <= 3")
    out = tmp_path / "derived.duckdb"
    written = cohort_derive.derive(source, TargetSpec("file", path=str(out), fresh_file=True), members, MAPPING, "patient", True)
    by_table = {w["table"]: w for w in written}
    assert by_table["person"]["rows"] == 3
    assert by_table["visit_occurrence"]["rows"] == 6
    assert by_table["measurement"]["rows"] == 12
    assert by_table["concept"] == {"schema": None, "table": "concept", "filter": None, "rows": 5, "skipped": False}
    assert _rows(out, "visit_detail") == 12


def test_visit_detail_level_filters_on_the_finest_id_each_table_carries(source, tmp_path):
    # Unit stays 1 and 2: both in stay 1, patient 1.
    members = cohort_derive.compute_members(source, "SELECT visit_detail_id AS id, person_id AS patient_id FROM visit_detail WHERE visit_detail_id <= 2")
    out = tmp_path / "derived.duckdb"
    written = {w["table"]: w for w in cohort_derive.derive(
        source, TargetSpec("file", path=str(out), fresh_file=True), members, MAPPING, "visit_detail", False)}
    assert written["visit_detail"] == {"schema": None, "table": "visit_detail", "filter": "visit_detail", "rows": 2, "skipped": False}
    assert written["measurement"]["filter"] == "visit_detail" and written["measurement"]["rows"] == 2
    # The stay itself: its parent, not every stay of the patient.
    assert written["visit_occurrence"]["filter"] == "parent_visit" and written["visit_occurrence"]["rows"] == 1
    assert written["person"]["rows"] == 1
    # Unticked: person-less tables are not copied.
    assert written["concept"]["skipped"] is True


def test_into_a_named_schema_of_the_same_file(source):
    members = cohort_derive.compute_members(source, "SELECT visit_occurrence_id AS id, person_id AS patient_id FROM visit_occurrence WHERE person_id = 2")
    path = source.spec["path"]
    cohort_derive.derive(source, TargetSpec("file", path=path, schema="cohort_1234"), members, MAPPING, "visit", True)
    assert _rows(path, "visit_occurrence", "cohort_1234") == 2
    assert _rows(path, "visit_detail", "cohort_1234") == 4
    assert _rows(path, "person") == 10  # the source is untouched
    # Rebuilding needs an explicit replace: the schema exists now.
    with pytest.raises(duckdb.Error):
        cohort_derive.derive(source, TargetSpec("file", path=path, schema="cohort_1234"), members, MAPPING, "visit", True)
    cohort_derive.derive(source, TargetSpec("file", path=path, schema="cohort_1234", replace_schema=True), members, MAPPING, "visit", True)


@pytest.mark.parametrize("sql", [
    "SELECT 1 AS id, 1 AS patient_id; DROP TABLE person",
    "DELETE FROM person",
    "ATTACH '/tmp/x.duckdb' AS x",
    "SELECT 1 AS n",
])
def test_the_membership_query_can_only_read(source, sql):
    with pytest.raises((ValueError, duckdb.Error)):
        cohort_derive.compute_members(source, sql)
    assert _rows(source.spec["path"], "person") == 10


def test_the_membership_query_cannot_read_server_files(source, tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("hunter2")
    with pytest.raises(duckdb.Error) as err:
        cohort_derive.compute_members(source, f"SELECT CAST(content AS INTEGER) AS id, 1 AS patient_id FROM read_text('{secret}')")
    assert "hunter2" not in str(err.value)


def test_a_parquet_source_still_reads_its_own_files(tmp_path):
    path = tmp_path / "person.parquet"
    duckdb.execute(f"COPY (SELECT i AS person_id FROM range(1, 4) t(i)) TO '{path}' (FORMAT parquet)")
    src = SourceSpec({"kind": "parquet", "files": [("person.parquet", str(path))], "known": ["person"]})
    members = cohort_derive.compute_members(src, "SELECT person_id AS id, person_id AS patient_id FROM person")
    assert members.num_rows == 3
    other = tmp_path / "other.parquet"
    duckdb.execute(f"COPY (SELECT 1 AS x) TO '{other}' (FORMAT parquet)")
    with pytest.raises(duckdb.Error):
        cohort_derive.compute_members(src, f"SELECT x AS id, x AS patient_id FROM read_parquet('{other}')")


def test_a_multi_schema_source_goes_to_a_new_database_only(tmp_path):
    path = tmp_path / "mimic.duckdb"
    con = duckdb.connect(str(path))
    con.execute("CREATE SCHEMA hosp")
    con.execute("CREATE TABLE hosp.patients AS SELECT 1 AS subject_id")
    con.close()
    src = SourceSpec({"kind": "file", "engine": "duckdb", "path": str(path)})
    mapping = {"patientTable": {"schema": "hosp", "table": "patients", "idColumn": "subject_id"}}
    members = cohort_derive.compute_members(src, 'SELECT subject_id AS id, subject_id AS patient_id FROM "hosp"."patients"')
    out = tmp_path / "d.duckdb"
    written = cohort_derive.derive(src, TargetSpec("file", path=str(out), fresh_file=True), members, mapping, "patient", True)
    assert written[0]["schema"] == "hosp" and _rows(out, "patients", "hosp") == 1
    with pytest.raises(ValueError, match="several schemas"):
        cohort_derive.derive(src, TargetSpec("file", path=str(tmp_path / "e.duckdb"), schema="c"), members, mapping, "patient", True)


def test_plan_describes_each_table_before_anything_runs(source):
    plan = {p["table"]: p["filter"] for p in cohort_derive.plan(source, MAPPING, "visit")}
    assert plan == {"concept": None, "measurement": "visit", "person": "patient", "visit_detail": "visit", "visit_occurrence": "visit"}


def test_a_cancelled_derivation_leaves_nothing_behind(source, tmp_path):
    members = cohort_derive.compute_members(source, "SELECT person_id AS id, person_id AS patient_id FROM person")
    seen: list[str] = []
    control = cohort_derive.DeriveControl()

    def on_table(done, total, table):
        seen.append(table)
        if done == 1:
            control.cancel()

    control.on_table = on_table
    out = tmp_path / "derived.duckdb"
    with pytest.raises(cohort_derive.DeriveCancelled):
        cohort_derive.derive(source, TargetSpec("file", path=str(out), fresh_file=True), members, MAPPING, "patient", True, control)
    assert len(seen) == 2 and not out.exists()

    # Into a schema of an existing file: the half-written schema is dropped.
    control = cohort_derive.DeriveControl(on_table=lambda done, total, table: control.cancel() if done == 1 else None)
    with pytest.raises(cohort_derive.DeriveCancelled):
        cohort_derive.derive(source, TargetSpec("file", path=source.spec["path"], schema="cohort_x"), members, MAPPING, "patient", True, control)
    con = duckdb.connect(source.spec["path"], read_only=True)
    try:
        assert con.execute("SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = 'cohort_x'").fetchone()[0] == 0
    finally:
        con.close()


def test_a_failed_rebuild_keeps_the_previous_build(source, tmp_path):
    members = cohort_derive.compute_members(source, "SELECT person_id AS id, person_id AS patient_id FROM person WHERE person_id <= 3")
    out = tmp_path / "derived.duckdb"
    cohort_derive.derive(source, TargetSpec("file", path=str(out), fresh_file=True), members, MAPPING, "patient", True)
    assert _rows(out, "person") == 3

    control = cohort_derive.DeriveControl()
    control.on_table = lambda done, total, table: control.cancel() if done == 1 else None
    with pytest.raises(cohort_derive.DeriveCancelled):
        cohort_derive.derive(source, TargetSpec("file", path=str(out), fresh_file=True), members, MAPPING, "patient", True, control)
    assert _rows(out, "person") == 3
    assert not (tmp_path / "derived.duckdb.tmp").exists()


def test_a_new_database_is_never_its_own_source(source):
    members = cohort_derive.compute_members(source, "SELECT person_id AS id, person_id AS patient_id FROM person")
    with pytest.raises(ValueError, match="its own file"):
        cohort_derive.derive(source, TargetSpec("file", path=source.spec["path"], fresh_file=True), members, MAPPING, "patient", True)
    assert _rows(source.spec["path"], "person") == 10


MAPPING_V2 = {
    "formatVersion": 2,
    "patient": {"from": {"table": "person", "alias": "p"}, "fields": {"patient_id": "p.person_id"}},
    "visit": {"from": {"table": "visit_occurrence", "alias": "v"}, "fields": {"visit_id": "v.visit_occurrence_id", "patient_id": "v.person_id"}},
    "visitDetail": {
        "from": {"table": "visit_detail", "alias": "vd"},
        "fields": {"visit_detail_id": "vd.visit_detail_id", "visit_id": "vd.visit_occurrence_id", "patient_id": "vd.person_id"},
    },
    "events": [{"label": "Measurement", "from": {"table": "measurement", "alias": "e"}, "fields": {"patient_id": "e.person_id"}}],
}


def test_a_v2_mapping_names_the_same_id_columns_as_its_v1_twin(source):
    assert cohort_derive.id_columns(MAPPING_V2) == cohort_derive.id_columns(MAPPING)
    for level in ("patient", "visit", "visit_detail"):
        assert cohort_derive.plan(source, MAPPING_V2, level) == cohort_derive.plan(source, MAPPING, level)


def test_a_relation_in_sql_or_an_expression_names_no_id_column():
    mapping = {
        "formatVersion": 2,
        "patient": {"customSql": "SELECT person_id AS patient_id FROM person", "from": {"table": "person", "alias": "p"}, "fields": {"patient_id": "p.person_id"}},
        "visit": {"from": {"table": "v", "alias": "v"}, "fields": {"visit_id": {"expr": "v.a || v.b"}, "patient_id": "x.person_id"}},
    }
    ids = cohort_derive.id_columns(mapping)
    assert ids.patient == set() and ids.visit == set()


def test_the_database_overrides_apply_before_the_ids_are_read():
    overrides = {"relations": {"visit": {"from": {"table": "stays", "alias": "s"}, "fields": {"visit_id": "s.stay_key", "patient_id": "s.pid"}}}}
    effective = cohort_derive.effective_mapping(MAPPING_V2, overrides)
    ids = cohort_derive.id_columns(effective)
    assert "stay_key" in ids.visit and "pid" in ids.patient
    assert cohort_derive.effective_mapping(MAPPING_V2, None) is MAPPING_V2
    assert cohort_derive.mapping_schemas({**MAPPING_V2, "note": {"from": {"schema": "note", "table": "d", "alias": "n"}}}) == {"note"}


def test_effective_mapping_replaces_a_renamed_event_in_place():
    # The app overrides a renamed base event under its base key (diffOverrides):
    # one relation, under its new label — never the old one beside it.
    renamed = {**MAPPING_V2["events"][0], "label": "Labs"}
    effective = cohort_derive.effective_mapping(MAPPING_V2, {"relations": {"events.Measurement": renamed}})
    assert [e["label"] for e in effective["events"]] == ["Labs"]


def test_a_table_read_without_a_patient_id_column_is_never_copied_whole(source, tmp_path):
    # measurement's patient id is an expression, visit_detail's relation is SQL:
    # neither table has an id column the mapping names, and copying them whole
    # would put every patient in the derived database.
    mapping = {
        **MAPPING_V2,
        "visitDetail": {"customSql": "SELECT visit_detail_id, person_id AS patient_id FROM visit_detail"},
        "events": [{"label": "Measurement", "from": {"table": "measurement", "alias": "e"}, "fields": {"patient_id": {"expr": "e.person_id + 0"}}}],
        "concepts": [{"key": "concept", "from": {"table": "concept", "alias": "c"}, "fields": {"concept_id": "c.concept_id"}}],
    }
    by_table = {p["table"]: p for p in cohort_derive.plan(source, mapping, "visit")}
    # Other relations name person_id and visit_occurrence_id: those still filter it.
    assert by_table["measurement"]["filter"] == "visit" and by_table["measurement"]["unresolved"] is None
    only_expr = {**mapping, "patient": {"customSql": "SELECT person_id AS patient_id FROM person"},
                 "visit": {"customSql": "SELECT * FROM visit_occurrence"}}
    by_table = {p["table"]: p for p in cohort_derive.plan(source, only_expr, "patient")}
    assert by_table["measurement"]["unresolved"] == "events.Measurement"
    assert by_table["visit_detail"]["unresolved"] == "visitDetail"
    assert by_table["concept"]["unresolved"] is None

    members = cohort_derive.compute_members(source, "SELECT person_id AS id, person_id AS patient_id FROM person WHERE person_id <= 3")
    out = tmp_path / "derived.duckdb"
    written = {w["table"]: w for w in cohort_derive.derive(source, TargetSpec("file", path=str(out), fresh_file=True), members, only_expr, "patient", True)}
    assert written["measurement"] == {"schema": "main", "table": "measurement", "filter": None, "rows": None, "skipped": True, "unresolved": "events.Measurement"}
    assert written["concept"]["rows"] == 5
