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
