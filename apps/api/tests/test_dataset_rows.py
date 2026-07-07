"""Round-trip + paging parity for the Parquet row store (dataset_rows)."""

from app.services.data.dataset_rows import read_parquet, write_parquet


def _roundtrip(rows, columns, **kw):
    return read_parquet(write_parquet(rows, columns), **kw)


def test_typed_roundtrip_preserves_values():
    cols = [
        {"id": "c0", "type": "string"},
        {"id": "c1", "type": "number"},
        {"id": "c2", "type": "boolean"},
        {"id": "c3", "type": "date"},
    ]
    rows = [
        {"c0": "A", "c1": 3.5, "c2": True, "c3": "2020-01-02"},
        {"c0": "B", "c1": 7, "c2": False, "c3": "2020-01-03"},
    ]
    out = _roundtrip(rows, cols)
    assert out[0] == {"c0": "A", "c1": 3.5, "c2": True, "c3": "2020-01-02"}
    # Integers come back as floats (no-op once the frontend coerces with Number()).
    assert out[1]["c1"] == 7.0
    # Dates/strings are stored as VARCHAR — preserved exactly, no format drift.
    assert out[1]["c3"] == "2020-01-03"


def test_nulls_and_missing_keys_become_null():
    cols = [{"id": "c0", "type": "string"}, {"id": "c1", "type": "number"}]
    rows = [{"c0": "A", "c1": None}, {"c0": "B"}]  # c1 missing in row 2
    out = _roundtrip(rows, cols)
    assert out == [{"c0": "A", "c1": None}, {"c0": "B", "c1": None}]


def test_columns_fallback_to_row_keys_when_undeclared():
    # A manually-created file writes rows before it has column metadata.
    out = _roundtrip([{"col-1-0": "x"}, {"col-1-0": "y"}], [])
    assert out == [{"col-1-0": "x"}, {"col-1-0": "y"}]


def test_empty_rows_and_columns():
    assert _roundtrip([], []) == []


def test_paging_with_limit_offset():
    cols = [{"id": "c0", "type": "string"}]
    rows = [{"c0": v} for v in ["a", "b", "c", "d"]]
    assert _roundtrip(rows, cols, offset=1, limit=2) == [{"c0": "b"}, {"c0": "c"}]
    assert _roundtrip(rows, cols, offset=0, limit=10) == rows
