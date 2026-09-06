"""Parquet folder -> table grouping. A flat folder of one-file-per-table
(``mimic-iv-raw-parquet/admissions.parquet``) must yield one table per file, not
collapse onto the parent directory. Mirrors the frontend's extractTableName
tests in apps/web/src/lib/duckdb/table-naming.test.ts."""

from app.services.data.db_connect import _group_parquet, _table_of, _table_ref_of

MIMIC_IV_FILES = [
    "admissions", "caregiver", "chartevents", "d_hcpcs", "d_icd_diagnoses",
    "d_icd_procedures", "d_items", "d_labitems", "datetimeevents",
    "diagnoses_icd", "drgcodes", "emar", "emar_detail", "hcpcsevents",
    "icustays", "ingredientevents", "inputevents", "labevents",
    "microbiologyevents", "omr", "outputevents", "patients", "pharmacy", "poe",
    "poe_detail", "prescriptions", "procedureevents", "procedures_icd",
    "provider", "services", "transfers",
]


def test_flat_folder_uses_file_name():
    assert _table_of("mimic-iv-raw-parquet/admissions.parquet", []) == "admissions"
    assert _table_of("mimic-iv-raw-parquet/d_icd_diagnoses.parquet", []) == "d_icd_diagnoses"


def test_flat_folder_keeps_every_table_distinct_without_a_schema():
    """The reported bug: no schema mapping -> known is empty -> all 31 files
    collapsed to the folder name and the source reported "Tables: 1"."""
    files = [(f"mimic-iv-raw-parquet/{n}.parquet", f"/tmp/{n}.parquet") for n in MIMIC_IV_FILES]
    groups = _group_parquet(files, [])
    assert len(groups) == len(MIMIC_IV_FILES)
    # The selected folder is not a schema, so every group is (None, <table>).
    assert {s for s, _ in groups} == {None}
    assert (None, "mimic-iv-raw-parquet") not in groups


def test_lone_known_table_does_not_hide_the_others():
    files = [(f"mimic-iv-raw-parquet/{n}.parquet", f"/tmp/{n}.parquet") for n in MIMIC_IV_FILES]
    groups = _group_parquet(files, ["provider"])
    assert len(groups) == len(MIMIC_IV_FILES)


def test_hive_shard_layout_uses_parent_dir():
    assert _table_of("wh/admissions/part-00000-abc.parquet", []) == "admissions"
    assert _table_of("wh/labevents/chunk_3.parquet", []) == "labevents"
    assert _table_of("wh/labevents/0001.parquet", []) == "labevents"


def test_shards_group_together_and_tables_stay_apart():
    files = [
        ("wh/admissions/part-00000.parquet", "/tmp/a0.parquet"),
        ("wh/admissions/part-00001.parquet", "/tmp/a1.parquet"),
        ("wh/patients/part-00000.parquet", "/tmp/p0.parquet"),
    ]
    groups = _group_parquet(files, [])
    assert set(groups) == {(None, "admissions"), (None, "patients")}
    assert len(groups[(None, "admissions")]) == 2


def test_real_table_starting_with_a_shard_keyword():
    assert _table_of("wh/data_quality.parquet", []) == "data_quality"
    assert _table_of("wh/file_registry.parquet", []) == "file_registry"
    assert _table_of("wh/partners.parquet", []) == "partners"


def test_known_tables_take_precedence():
    assert _table_of("dump/person/part-00000.parquet", ["person"]) == "person"
    assert _table_of("omop/PERSON.parquet", ["person"]) == "person"


def test_non_parquet_files_are_ignored():
    files = [
        ("wh/admissions.parquet", "/tmp/a.parquet"),
        ("wh/README.md", "/tmp/README.md"),
    ]
    assert set(_group_parquet(files, [])) == {(None, "admissions")}


# --- Schema directories -----------------------------------------------------
# A warehouse published one directory per module (MIMIC-IV's hosp/icu, eHOP's
# Oracle schemas) keeps those directories as schemas. The selected root never is
# one, or every flat import would land in a schema named after the folder.


def test_module_directory_becomes_a_schema():
    assert _table_ref_of("mimic-iv/hosp/patients.parquet", ["mimic-iv"], []) == (
        "hosp", "patients",
    )
    assert _table_ref_of("mimic-iv/icu/icustays.parquet", ["mimic-iv"], []) == (
        "icu", "icustays",
    )


def test_selected_root_is_not_a_schema():
    assert _table_ref_of(
        "mimic-iv-raw-parquet/admissions.parquet", ["mimic-iv-raw-parquet"], []
    ) == (None, "admissions")


def test_shard_layout_with_and_without_a_schema():
    assert _table_ref_of("wh/icu/chartevents/part-00000.parquet", ["wh"], []) == (
        "icu", "chartevents",
    )
    assert _table_ref_of("wh/admissions/part-00000.parquet", ["wh"], []) == (
        None, "admissions",
    )


def test_two_schemas_may_hold_the_same_table_name():
    """eHOP 4.4: EDBM_EDS.EHOP_PATIENT is de-identified, EDBM_ZPAT.EHOP_PATIENT
    nominative. Flattened, one of the two is simply lost."""
    files = [
        ("ehop/EDBM_EDS/EHOP_PATIENT.parquet", "/tmp/eds.parquet"),
        ("ehop/EDBM_ZPAT/EHOP_PATIENT.parquet", "/tmp/zpat.parquet"),
    ]
    groups = _group_parquet(files, [])
    assert set(groups) == {
        ("edbm_eds", "ehop_patient"),
        ("edbm_zpat", "ehop_patient"),
    }


def test_mimic_modules_group_into_two_schemas():
    files = [
        ("mimic-iv/hosp/patients.parquet", "/tmp/p.parquet"),
        ("mimic-iv/hosp/admissions.parquet", "/tmp/a.parquet"),
        ("mimic-iv/icu/icustays.parquet", "/tmp/i.parquet"),
    ]
    groups = _group_parquet(files, [])
    assert {s for s, _ in groups} == {"hosp", "icu"}


def test_known_tables_do_not_swallow_the_schema():
    assert _table_ref_of("mimic-iv/hosp/patients.parquet", ["mimic-iv"], ["patients"]) == (
        "hosp", "patients",
    )


def test_only_the_directory_just_above_the_table_is_the_schema():
    assert _table_ref_of("a/b/c/hosp/patients.parquet", ["a", "b", "c"], []) == (
        "hosp", "patients",
    )


def test_table_part_agrees_with_table_of():
    for path in (
        "mimic-iv-raw-parquet/admissions.parquet",
        "wh/admissions/part-00000.parquet",
        "omop/PERSON.parquet",
    ):
        assert _table_ref_of(path, [], [])[1] == _table_of(path, [])
