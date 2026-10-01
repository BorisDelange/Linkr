"""Small-count masking of source-concepts.csv on export (security plan B3): a
mapping project leaving an SPE for the global instance carries no count under
the threshold and no single patient's value. The fixture is shared with
export-masking.test.ts — both sides must emit the same bytes."""

import json
from pathlib import Path

import pytest

from app.services.export_masking import SourceConceptsUnreadable, _js_json, mask_frequency, mask_source_concepts_csv
from app.services.mapping_project_export import _as_csv_bytes, _masked_csv_bytes, build_mapping_project_tree

FIXTURES = Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "concept-mapping" / "__fixtures__" / "export-masking"


def _read(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def test_the_shared_fixture():
    assert mask_source_concepts_csv(_read("input.csv"), None, 11) == _read("expected.csv")
    assert mask_source_concepts_csv(
        _read("input-semicolon.csv"), {"recordCountColumn": "n_records"}, 11
    ) == _read("expected-semicolon.csv")


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
