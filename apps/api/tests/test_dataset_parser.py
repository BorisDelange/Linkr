from pathlib import Path

from app.services.data.dataset_parser import parse_blob, preview_blob
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


def test_infer_scans_whole_column_not_just_head():
    # Regression: a column numeric for its first hundreds of rows but with an
    # alphanumeric code later (MIMIC itemids then ICD codes) must be `string`,
    # not `number` — a wrong `number` verdict broke the Parquet write and made
    # the whole import silently produce no columns.
    values = [str(200000 + i) for i in range(400)] + ["G894"]
    assert infer_column_type(values) == "string"


# --- End-to-end CSV parse ---

def _write(tmp_path, name, text) -> Path:
    p = tmp_path / name
    p.write_text(text)
    return p


def test_parse_csv_columns_rows_keyed_by_id(tmp_path):
    p = _write(tmp_path, "d.csv", "patient,value,flag\nA,3.5,yes\nB,7,no\n")
    columns, rows, count = parse_blob(p, "d.csv", {"hasHeader": True})

    assert [c["name"] for c in columns] == ["patient", "value", "flag"]
    # ids are deterministic name-slugs (col_<slug>), identical to the client util
    assert [c["id"] for c in columns] == ["col_patient", "col_value", "col_flag"]
    assert [c["type"] for c in columns] == ["string", "number", "boolean"]
    assert count == 2
    # rows are keyed by columnId, values coerced by inferred type
    assert rows[0] == {"col_patient": "A", "col_value": 3.5, "col_flag": True}
    assert rows[1] == {"col_patient": "B", "col_value": 7, "col_flag": False}


def test_parse_csv_custom_delimiter(tmp_path):
    p = _write(tmp_path, "d.csv", "a;b\n1;2\n3;4\n")
    columns, rows, count = parse_blob(p, "d.csv", {"delimiter": ";"})
    assert [c["name"] for c in columns] == ["a", "b"]
    assert count == 2
    assert rows[0]["col_a"] == 1


def test_csv_renamed_as_xlsx_gives_clear_error(tmp_path):
    # A CSV renamed to .xlsx is a common trap — expect a helpful ValueError,
    # not DuckDB's cryptic "Failed to open zip".
    import pytest

    p = _write(tmp_path, "fake.xlsx", "a,b\n1,2\n")
    with pytest.raises(ValueError, match="not a valid Excel"):
        parse_blob(p, "fake.xlsx", {})


def test_parse_empty_cell_is_none(tmp_path):
    p = _write(tmp_path, "d.csv", "a,b\nx,\n")
    columns, rows, _ = parse_blob(p, "d.csv", {})
    assert rows[0]["col_b"] is None


def test_parse_mixed_numeric_alnum_column_is_string(tmp_path):
    # The `concept_code` shape: leading numeric itemids then ICD codes. Whole-file
    # inference must type it `string` so the import doesn't fail on the Parquet cast.
    head = "".join(f"{200000 + i}\n" for i in range(300))
    p = _write(tmp_path, "codes.csv", "concept_code\n" + head + "G894\nC9754\n")
    columns, rows, count = parse_blob(p, "codes.csv", {})
    assert columns[0]["type"] == "string"
    assert count == 302
    assert rows[-1]["col_concept_code"] == "C9754"
    assert rows[-2]["col_concept_code"] == "G894"


# --- Server-side preview parity with the persisted parse ---

def test_preview_types_and_count_match_parse(tmp_path):
    csv = "a,b,c,d,e\n1,true,2020-01-01,foo,\n2,no,2020-06-15,bar,3\nX99,false,2021-12-31,baz,7\n"
    p = _write(tmp_path, "mix.csv", csv)
    prev = preview_blob(p, "mix.csv", None)
    columns, _rows, count = parse_blob(p, "mix.csv", None)

    prev_types = {c["name"]: c["type"] for c in prev["columns"]}
    parse_types = {c["name"]: c["type"] for c in columns}
    assert prev_types == parse_types
    assert prev["rowCount"] == count
    # ids/order also match so the dialog preview keys rows exactly like the import.
    assert [c["id"] for c in prev["columns"]] == [c["id"] for c in columns]


def test_preview_caps_rows_but_counts_all(tmp_path):
    body = "".join(f"{i},v{i}\n" for i in range(500))
    p = _write(tmp_path, "big.csv", "id,label\n" + body)
    prev = preview_blob(p, "big.csv", None)
    assert prev["rowCount"] == 500
    assert len(prev["preview"]) <= 50
    assert prev["preview"][0] == {"col_id": 0, "col_label": "v0"}


def test_preview_mixed_alnum_column_is_string(tmp_path):
    head = "".join(f"{200000 + i}\n" for i in range(300))
    p = _write(tmp_path, "codes.csv", "concept_code\n" + head + "G894\n")
    prev = preview_blob(p, "codes.csv", None)
    assert prev["columns"][0]["type"] == "string"


# --- Per-column type override (right-click "Treat as…") ---

def test_type_override_wins_over_inference(tmp_path):
    # id infers as number; force it to string. The forced type is applied and the
    # value is kept as text (not coerced to a float).
    p = _write(tmp_path, "d.csv", "id,label\n1,a\n2,b\n")
    opts = {"columnTypes": {"col_id": "string"}}
    columns, rows, _ = parse_blob(p, "d.csv", opts)
    by_name = {c["name"]: c["type"] for c in columns}
    assert by_name["id"] == "string"
    assert rows[0]["col_id"] == "1"


def test_preview_type_override_matches_parse(tmp_path):
    p = _write(tmp_path, "d.csv", "id,label\n1,a\n2,b\n")
    opts = {"columnTypes": {"col_id": "string"}}
    prev = preview_blob(p, "d.csv", opts)
    assert {c["name"]: c["type"] for c in prev["columns"]}["id"] == "string"


def test_invalid_type_override_ignored(tmp_path):
    p = _write(tmp_path, "d.csv", "id\n1\n2\n")
    columns, _, _ = parse_blob(p, "d.csv", {"columnTypes": {"col_id": "bogus"}})
    # Falls back to inference (number), never trusts an unknown type string.
    assert columns[0]["type"] == "number"
