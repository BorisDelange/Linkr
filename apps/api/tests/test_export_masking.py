"""Small-count masking of source-concepts.csv on export (security plan B3): a
mapping project leaving an SPE for the global instance carries no count under
the threshold and no single patient's value. The fixture is shared with
export-masking.test.ts — both sides must emit the same bytes."""

import csv
import io
import json
from pathlib import Path

import pytest

from app.services.export_masking import SourceConceptsUnreadable, _js_json, mask_frequency, mask_profile, mask_source_concepts_csv
from app.services.mapping_project_export import _as_csv_bytes, _masked_csv_bytes, build_mapping_project_tree

FIXTURES = Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "concept-mapping" / "__fixtures__" / "export-masking"


def _read(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def test_the_shared_fixture():
    assert mask_source_concepts_csv(_read("input.csv"), None, 11) == _read("expected.csv")
    assert mask_source_concepts_csv(
        _read("input-semicolon.csv"), {"recordCountColumn": "n_records", "terminologyColumn": "vocab"}, 11
    ) == _read("expected-semicolon.csv")


def test_the_shared_allowlist_fixture():
    masked = mask_source_concepts_csv(_read("input-allowlist.csv"), None, 11)
    assert masked == _read("expected-allowlist.csv")
    assert "DUMMY" not in masked
    assert mask_source_concepts_csv(masked, None, 11) == masked


def _masked_profile(profile: dict) -> dict | None:
    return mask_profile(json.loads(json.dumps(profile)), 11, "50", "500")


BASE = {"rows_count": 500, "patients_count": 50}


@pytest.mark.parametrize("field", [
    {"sample_values": ["DUMMY"]},
    {"first_seen": "2020-01-01"},
    {"anything": 3},
    {"unit": {"nested": "DUMMY"}},
    {"full_name": ["DUMMY"]},
    {"data_types": [{"a": "DUMMY"}]},
    {"measurement_frequency": "DUMMY"},
])
def test_a_field_nobody_judged_stays_behind(field):
    assert _masked_profile({**BASE, **field}) == {**BASE, "masked_k": 11}


def test_each_block_keeps_only_its_judged_fields():
    out = _masked_profile({
        **BASE,
        "numeric_data": {"mean": 3, "p100": 9, "other": 1, "sd": "DUMMY", "numeric_count": 500, "numeric_patients_count": 50},
        "categorical_data": [{"category": "a", "count": 500, "percentage": 100, "examples": ["DUMMY"], "percentage_note": "x"}],
        "hospital_units": [{"unit": "ICU", "count": 500, "percentage": "DUMMY", "who": "DUMMY"}],
        "temporal_distribution": {"first_event": "x", "by_month": [], "by_year": [{"year": 2020, "count": 500, "who": "DUMMY"}]},
    })
    assert out["numeric_data"] == {"mean": 3, "numeric_count": 500, "numeric_patients_count": 50}
    assert out["categorical_data"] == [{"category": "a", "count": 500, "percentage": 100}]
    assert out["hospital_units"] == [{"unit": "ICU", "count": 500}]
    assert out["temporal_distribution"] == {"by_year": [{"year": 2020, "count": 500}]}


def test_a_stamp_over_a_profile_no_pass_went_through_is_not_believed():
    out = _masked_profile({
        **BASE, "masked_k": 11, "range": [0, 99],
        "numeric_data": {"p1": 1, "mean": 5, "numeric_count": 500, "numeric_patients_count": 50},
        "histogram": [{"x": 1.3, "count": 100}, {"x": 50.7, "count": 200}, {"x": 98.1, "count": 200}],
    })
    assert [b["x"] for b in out["histogram"]] == [55] or len(out["histogram"]) < 3


def test_a_stamp_never_keeps_percentiles_too_few_values_support():
    out = _masked_profile({
        **BASE, "masked_k": 11,
        "numeric_data": {"p1": 1, "p99": 98, "mean": 5, "numeric_count": 50, "numeric_patients_count": 50},
    })
    assert "p1" not in out["numeric_data"] and "p99" not in out["numeric_data"]


def test_nothing_to_mask_is_byte_for_byte():
    text = "terminology,concept_code,record_count\r\nX,1,500\r\n"
    assert mask_source_concepts_csv(text, None, 11) == text
    assert mask_source_concepts_csv(_read("input.csv"), None, 1) == _read("input.csv")


@pytest.mark.parametrize("value", [0, 1, -2, 36.6, 0.1, 1e-7, 1.5e-6, 123456789.125, 1e20, 1e21, 2.5e25, -0.00001, "é \"", [1.0, None, True]])
def test_json_is_written_as_javascript_writes_it(value):
    expected = {
        0: "0", 1: "1", -2: "-2", 36.6: "36.6", 0.1: "0.1", 1e-7: "1e-7", 1.5e-6: "0.0000015",
        123456789.125: "123456789.125", 1e20: "100000000000000000000", 1e21: "1e+21",
        2.5e25: "2.5e+25", -0.00001: "-0.00001",
    }
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        assert _js_json(float(value) if isinstance(value, float) else value) == expected[value]
    elif isinstance(value, str):
        assert _js_json(value) == '"é \\""'
    else:
        assert _js_json(value) == "[1,null,true]"


def test_every_server_export_goes_through_it(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "export_min_count", 11)
    project = {"sourceType": "file", "fileSourceData": {"columnMapping": {}}}
    mappings = [{"sourceConceptCode": "A", "sourceFrequency": 4}, {"sourceConceptCode": "B", "sourceFrequency": 400}]
    tree = build_mapping_project_tree(
        project=project, mappings=mappings, ranges=[], entries=[], organization=None,
        source_csv=_read("input.csv").encode(),
    )
    assert tree["source-concepts.csv"].decode() == _read("expected.csv")
    assert [m["sourceFrequency"] for m in json.loads(tree["mappings.json"])] == [None, 400]
    assert mask_frequency(True) is True


def test_a_windows_1252_file_is_read_not_shipped_unmasked():
    data = (FIXTURES / "input-cp1252.csv").read_bytes()
    assert _masked_csv_bytes(data, None).decode() == _read("expected.csv")


@pytest.mark.parametrize("data", [b"a,b\n\x81\n", b"a,record_count\nx,\x003\n"])
def test_bytes_that_cannot_be_read_are_refused(data):
    with pytest.raises(SourceConceptsUnreadable):
        _masked_csv_bytes(data, None)


def test_an_unreadable_parquet_is_refused():
    with pytest.raises(SourceConceptsUnreadable):
        _as_csv_bytes(b"PAR1\x00\x01")


def test_a_byte_order_mark_is_dropped_as_the_browser_drops_it():
    data = b"\xef\xbb\xbf" + (FIXTURES / "input.csv").read_bytes()
    assert _masked_csv_bytes(data, None).decode() == _read("expected.csv")
    assert mask_source_concepts_csv("\ufeffcode,name\n1,2\n", None, 11) == "code,name\n1,2\n"


def test_a_threshold_of_0_masks_nothing_as_in_the_browser():
    text = "concept,patient_count\na,5\n"
    assert mask_frequency(5, 0) == 5
    assert mask_source_concepts_csv(text, None, 0) == text


def _large_cells() -> str:
    """Twin of largeCells() in export-masking.test.ts: a profile cell over the csv
    module's default 128 KiB field limit, and one nested far past the depth cap."""
    big = '"{""rows_count"":500,""patients_count"":50,""range"":[' + "0," * 100_000 + '0]}"'
    deep = '"{""rows_count"":500,""patients_count"":50,""x"":' + "[" * 5_000 + "]" * 5_000 + '}"'
    return f"concept_code,record_count,patient_count,info_json\nBIG,500,50,{big}\nDEEP,500,50,{deep}\n"


def test_a_cell_over_the_csv_field_limit_is_masked_not_shipped_as_it_is():
    text = _large_cells()
    assert len(text) > 200 * 1024
    assert mask_source_concepts_csv(text, None, 11) == _read("expected-large-cell.csv")


def test_a_file_the_csv_reader_refuses_is_not_exported(monkeypatch):
    import csv

    from app.services import export_masking

    def refuse(*_args, **_kwargs):
        raise csv.Error("field larger than field limit")

    monkeypatch.setattr(export_masking.csv, "reader", refuse)
    with pytest.raises(SourceConceptsUnreadable):
        _masked_csv_bytes(_read("input.csv").encode(), None)


def test_masking_an_already_masked_file_changes_nothing():
    # A pulled file is masked already; pushing it back must not erode it further
    # (the histogram's edge bins used to go again on every export).
    once = mask_source_concepts_csv(_read("input.csv"), None, 11)
    assert mask_source_concepts_csv(once, None, 11) == once
    # A higher threshold masks again, edges included.
    assert mask_source_concepts_csv(once, None, 20) != once


_SKIP_PIPE = {"skipRows": 2, "delimiter": "|"}
_SKIP_PIPE_MAPPING = {"patientCountColumn": "n_pat", "recordCountColumn": "n_rec"}
_NO_HEADER_MAPPING = {"conceptCodeColumn": "column0", "conceptNameColumn": "column1", "patientCountColumn": "column2"}


def test_the_file_is_read_with_its_parse_options():
    assert mask_source_concepts_csv(
        _read("input-skip-pipe.csv"), _SKIP_PIPE_MAPPING, 11, _SKIP_PIPE
    ) == _read("expected-skip-pipe.csv")
    assert mask_source_concepts_csv(
        _read("input-no-header.csv"), _NO_HEADER_MAPPING, 11, {"hasHeader": False}
    ) == _read("expected-no-header.csv")


def test_a_mapped_count_column_the_file_does_not_have_is_refused():
    with pytest.raises(SourceConceptsUnreadable):
        mask_source_concepts_csv(_read("input-skip-pipe.csv"), _SKIP_PIPE_MAPPING, 11, None)


def test_a_server_export_reads_the_source_with_the_project_parse_options(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "export_min_count", 11)
    project = {"sourceType": "file", "fileSourceData": {"columnMapping": _SKIP_PIPE_MAPPING, "parseOptions": _SKIP_PIPE}}
    tree = build_mapping_project_tree(
        project=project, mappings=[], ranges=[], entries=[], organization=None,
        source_csv=_read("input-skip-pipe.csv").encode(),
    )
    assert tree["source-concepts.csv"].decode() == _read("expected-skip-pipe.csv")


def _profile_row(profile: dict, records: int = 500, patients: int = 50) -> str:
    cell = json.dumps(profile).replace('"', '""')
    return f'concept_code,record_count,patient_count,info_json\nA,{records},{patients},"{cell}"\n'


def _masked_profile(profile: dict) -> dict:
    rows = list(csv.reader(io.StringIO(mask_source_concepts_csv(_profile_row(profile), None, 11))))
    return json.loads(rows[1][3])


_STATS = {"p25": 72.4, "median": 72.4, "mean": 72.4, "p75": 72.4}


@pytest.mark.parametrize("counts", [
    {"numeric_count": 1, "numeric_patients_count": 1},
    {"numeric_count": 2, "numeric_patients_count": 2},
    {"numeric_count": 400, "numeric_patients_count": 1},
    {"numeric_count": 400},
    {"numeric_count": 5, "numeric_patients_count": 50},
    {"numeric_patients_count": "2e0"},
    {},
])
def test_a_numeric_block_leaves_only_over_k_known_patients(counts):
    out = _masked_profile({
        "rows_count": 500, "patients_count": 50, "numeric_data": {**_STATS, **counts},
        "histogram": [{"x": 72.5, "count": 300}, {"x": 73.5, "count": 100}, {"x": 74.5, "count": 100}],
    })
    assert "numeric_data" not in out and "histogram" not in out


def test_a_numeric_block_over_k_patients_stays_with_its_counts():
    counts = {"numeric_count": 400, "numeric_patients_count": 30}
    out = _masked_profile({"rows_count": 500, "patients_count": 50, "numeric_data": {**_STATS, **counts}})
    assert out["numeric_data"] == {**_STATS, **counts}


@pytest.mark.parametrize("block", [[1, 2], 72.4, "72.4"])
def test_a_numeric_block_that_is_not_an_object_does_not_leave(block):
    out = _masked_profile({"rows_count": 500, "patients_count": 50, "numeric_data": block, "records_per_patient": block})
    assert "numeric_data" not in out and "records_per_patient" not in out


@pytest.mark.parametrize(("rate", "kept"), [(99.8, False), (0.2, False), (50.0, True), (0, True), (100, True), ("n/a", False)])
def test_a_missing_rate_does_not_give_a_small_count_back(rate, kept):
    out = _masked_profile({"rows_count": 500, "patients_count": 50, "missing_rate": rate})
    assert ("missing_rate" in out) is kept


def _cells(text: str) -> list[dict]:
    rows = list(csv.reader(io.StringIO(text)))
    return [dict(zip(rows[0], r)) for r in rows[1:]]


_OTHER_COUNTS = "concept_code,nb_rec,rows_count,patients_count,n_patients\nA,3,5,7,2\nB,300,500,70,20\n"


def test_every_count_column_is_masked_not_only_the_first_of_its_role():
    cells = _cells(mask_source_concepts_csv(_OTHER_COUNTS, None, 11))
    assert cells[0] == {"concept_code": "A", "nb_rec": "<11", "rows_count": "<11", "patients_count": "<11", "n_patients": "<11"}
    assert cells[1] == {"concept_code": "B", "nb_rec": "300", "rows_count": "500", "patients_count": "70", "n_patients": "20"}


def test_a_mapped_count_column_leaves_the_other_count_columns_masked():
    text = "concept_code,record_count,patient_count,nb_rec,n_patients\nA,4,6,30,20\n"
    cells = _cells(mask_source_concepts_csv(text, {"recordCountColumn": "nb_rec", "patientCountColumn": "n_patients"}, 11))
    assert cells[0]["record_count"] == "<11" and cells[0]["patient_count"] == "<11"


def test_a_second_profile_column_is_masked_as_the_first():
    profile = json.dumps({"rows_count": 500, "patients_count": 50, "numeric_data": {"min": 1, "max": 9}}).replace('"', '""')
    text = f'concept_code,patient_count,info_json,other_profile\nA,50,"{profile}","{profile}"\nB,50,,"{{""rows_count"":3}}"\nC,50,,"[1,2]"\n'
    cells = _cells(mask_source_concepts_csv(text, None, 11))
    assert "min" not in cells[0]["other_profile"] and "max" not in cells[0]["other_profile"]
    assert cells[1]["other_profile"] == "" and cells[2]["other_profile"] == ""


def test_a_value_column_never_leaves_even_when_chosen():
    text = "concept_code,patient_count,sample_values,minValue,valeur_max,début\nA,50,DUMMY-A,3.2,250,2020-01-01\n"
    mapping = {"conceptCodeColumn": "concept_code", "extraColumns": ["sample_values", "minValue", "valeur_max", "début"]}
    cell = _cells(mask_source_concepts_csv(text, mapping, 11))[0]
    assert (cell["sample_values"], cell["minValue"], cell["valeur_max"], cell["début"]) == ("", "", "", "")


def test_a_column_the_project_did_not_choose_is_emptied_and_a_chosen_one_kept():
    text = "concept_code,concept_name,patient_count,specimen,free_note\n3,Three,50,blood,DUMMY-NOTE\n4,Four,2,urine,DUMMY-OTHER\n"
    mapping = {"conceptCodeColumn": "concept_code", "conceptNameColumn": "concept_name", "extraColumns": ["specimen"]}
    cells = _cells(mask_source_concepts_csv(text, mapping, 11))
    assert cells[0] == {"concept_code": "3", "concept_name": "Three", "patient_count": "50", "specimen": "blood", "free_note": ""}
    assert cells[1] == {"concept_code": "4", "concept_name": "Four", "patient_count": "<11", "specimen": "", "free_note": ""}


def test_a_small_number_in_any_other_column_is_masked():
    text = "concept_code,score,big,note\nA,3,4000,3 patients\n"
    cell = _cells(mask_source_concepts_csv(text, {"extraColumns": ["score", "big", "note"]}, 11))[0]
    assert cell == {"concept_code": "A", "score": "<11", "big": "4000", "note": "<11"}


@pytest.mark.parametrize("cell", ["5,0", "+5", "1e0", "5 patients", "5 ", "~5", "-1", "0x5", "1_0"])
def test_a_count_cell_that_is_no_plain_number_is_masked(cell):
    quoted = '"' + cell + '"'
    assert _cells(mask_source_concepts_csv(f"concept_code,record_count\nA,{quoted}\n", None, 11))[0]["record_count"] == "<11"


@pytest.mark.parametrize("text", [
    'concept_code;name;record_count;patient_count\nA1;"unbalanced name;30;20\nA2;x;2;2\nA3;y;3;3\n',
    'concept_code,record_count\n"A"B,3\n',
    'concept_code,record_count\n"A" ,3\n',
    "concept_code,record_count\nA,3,extra\n",
    "concept_code,name,record_count\nA,3\n",
])
def test_a_file_not_read_row_for_row_is_not_exported(text):
    with pytest.raises(SourceConceptsUnreadable):
        mask_source_concepts_csv(text, None, 11)


@pytest.mark.parametrize("skip", [1, 2])
def test_line_endings_do_not_change_the_rows_read(skip):
    head = "Generated\r" * (skip - 1) + "concept_code,record_count\r"
    out = mask_source_concepts_csv(head + "X,3\rY,300\r", None, 11, {"skipRows": skip - 1})
    assert out.endswith("concept_code,record_count\nX,<11\nY,300\n")


def test_rows_to_skip_the_file_does_not_have_are_refused():
    with pytest.raises(SourceConceptsUnreadable):
        mask_source_concepts_csv("concept_code,record_count", None, 11, {"skipRows": 5})


def test_only_a_real_lfs_pointer_is_left_as_it_is():
    pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a" * 64 + "\nsize 12\n"
    assert mask_source_concepts_csv(pointer, None, 11) == pointer
    text = "version https://git-lfs,record_count\nA,3\n"
    assert "<11" in mask_source_concepts_csv(text, None, 11)


def test_the_shared_fixture_of_other_columns():
    mapping = {"conceptCodeColumn": "concept_code", "conceptNameColumn": "concept_name", "extraColumns": ["specimen"]}
    assert mask_source_concepts_csv(_read("input-columns.csv"), mapping, 11) == _read("expected-columns.csv")
