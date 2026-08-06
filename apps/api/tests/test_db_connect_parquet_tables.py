"""Parquet folder -> table grouping. A flat folder of one-file-per-table
(``mimic-iv-raw-parquet/admissions.parquet``) must yield one table per file, not
collapse onto the parent directory. Mirrors the frontend's extractTableName
tests in apps/web/src/lib/duckdb/table-naming.test.ts."""

from app.services.data.db_connect import _group_parquet, _table_of

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
    assert "mimic-iv-raw-parquet" not in groups


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
    assert set(groups) == {"admissions", "patients"}
    assert len(groups["admissions"]) == 2


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
    assert set(_group_parquet(files, [])) == {"admissions"}
