from pathlib import Path

from app.services.data.dataset_parser import parse_blob
from app.services.data.type_inference import infer_column_type


# --- Type inference parity with apps/web/src/lib/dataset-utils.ts ---

def test_infer_number():
    assert infer_column_type(["1", "2.5", "-3", "1e4"]) == "number"


def test_infer_boolean_en_fr():
    assert infer_column_type(["yes", "no", "true", "false"]) == "boolean"
    assert infer_column_type(["oui", "non", "vrai", "faux"]) == "boolean"


def test_infer_boolean_beats_number_for_0_1():
    # 0/1 are valid booleans AND numbers; priority is boolean.
    assert infer_column_type(["0", "1", "1", "0"]) == "boolean"


def test_infer_date():
    assert infer_column_type(["2020-01-02", "2021-12-31"]) == "date"
    assert infer_column_type(["2020-01-02T10:30:00Z"]) == "date"


def test_infer_string_and_unknown():
    assert infer_column_type(["hello", "world", "42"]) == "string"
    assert infer_column_type([None, "", None]) == "unknown"


def test_infer_ignores_blanks():
    assert infer_column_type(["1", "", None, "2"]) == "number"


# --- End-to-end CSV parse ---

def _write(tmp_path, name, text) -> Path:
    p = tmp_path / name
    p.write_text(text)
    return p


def test_parse_csv_columns_rows_keyed_by_id(tmp_path):
    p = _write(tmp_path, "d.csv", "patient,value,flag\nA,3.5,yes\nB,7,no\n")
    columns, rows, count = parse_blob(p, "d.csv", {"hasHeader": True}, stamp=999)

    assert [c["name"] for c in columns] == ["patient", "value", "flag"]
    assert [c["id"] for c in columns] == ["col-999-0", "col-999-1", "col-999-2"]
    assert [c["type"] for c in columns] == ["string", "number", "boolean"]
    assert count == 2
    # rows are keyed by columnId, values coerced by inferred type
    assert rows[0] == {"col-999-0": "A", "col-999-1": 3.5, "col-999-2": True}
    assert rows[1] == {"col-999-0": "B", "col-999-1": 7, "col-999-2": False}


def test_parse_csv_custom_delimiter(tmp_path):
    p = _write(tmp_path, "d.csv", "a;b\n1;2\n3;4\n")
    columns, rows, count = parse_blob(p, "d.csv", {"delimiter": ";"}, stamp=1)
    assert [c["name"] for c in columns] == ["a", "b"]
    assert count == 2
    assert rows[0]["col-1-0"] == 1


def test_csv_renamed_as_xlsx_gives_clear_error(tmp_path):
    # A CSV renamed to .xlsx is a common trap — expect a helpful ValueError,
    # not DuckDB's cryptic "Failed to open zip".
    import pytest

    p = _write(tmp_path, "fake.xlsx", "a,b\n1,2\n")
    with pytest.raises(ValueError, match="not a valid Excel"):
        parse_blob(p, "fake.xlsx", {}, 1)


def test_parse_empty_cell_is_none(tmp_path):
    p = _write(tmp_path, "d.csv", "a,b\nx,\n")
    columns, rows, _ = parse_blob(p, "d.csv", {}, stamp=1)
    assert rows[0]["col-1-1"] is None
