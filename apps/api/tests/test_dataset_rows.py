"""Round-trip + paging parity for the Parquet row store (dataset_rows)."""

from app.services.data.dataset_rows import (
    distinct_values,
    query_page,
    read_parquet,
    write_parquet,
)


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


def test_french_boolean_tokens_survive_the_write():
    # Regression: inference classifies oui/non/vrai/faux/o as boolean and the
    # preview renders them True/False, but DuckDB's `try_cast(x AS BOOLEAN)`
    # returns NULL for exactly those FR tokens — so the old projection silently
    # NULLed a whole French boolean column on import (preview != import). The
    # projection now mirrors parse_boolean's token sets.
    cols = [{"id": "c0", "type": "boolean"}]
    rows = [
        {"c0": "oui"}, {"c0": "non"}, {"c0": "vrai"}, {"c0": "faux"},
        {"c0": "o"}, {"c0": "yes"}, {"c0": "no"}, {"c0": "TRUE"},
        {"c0": " Oui "}, {"c0": "xyz"}, {"c0": None},
    ]
    out = _roundtrip(rows, cols)
    assert [r["c0"] for r in out] == [
        True, False, True, False, True, True, False, True, True, None, None
    ]


def test_uncastable_value_in_number_column_becomes_null_not_crash():
    # Safety net for a too-optimistic type verdict: a non-numeric cell in a column
    # declared `number` must try_cast to NULL, never abort the whole write (the
    # bug that surfaced as "This dataset has no columns").
    cols = [{"id": "c0", "type": "number"}]
    rows = [{"c0": "1"}, {"c0": "G894"}, {"c0": "3"}]
    out = _roundtrip(rows, cols)
    assert out == [{"c0": 1.0}, {"c0": None}, {"c0": 3.0}]


def test_columns_fallback_to_row_keys_when_undeclared():
    # A manually-created file writes rows before it has column metadata.
    out = _roundtrip([{"col-1-0": "x"}, {"col-1-0": "y"}], [])
    assert out == [{"col-1-0": "x"}, {"col-1-0": "y"}]


def test_write_parquet_honors_dir(tmp_path):
    # The temp must land in `dir` so the caller's os.replace into that same dir is
    # a same-device rename — a cross-device replace (/tmp -> mounted volume) raises
    # OSError 18 in Docker. Verify the temp is under dir and the file round-trips.
    dest_dir = tmp_path / "cache"
    out = write_parquet([{"c0": "a"}, {"c0": "b"}], [{"id": "c0", "type": "string"}], dir=dest_dir)
    assert dest_dir in out.parents
    assert read_parquet(out) == [{"c0": "a"}, {"c0": "b"}]


def test_empty_rows_and_columns():
    assert _roundtrip([], []) == []


def test_paging_with_limit_offset():
    cols = [{"id": "c0", "type": "string"}]
    rows = [{"c0": v} for v in ["a", "b", "c", "d"]]
    assert _roundtrip(rows, cols, offset=1, limit=2) == [{"c0": "b"}, {"c0": "c"}]
    assert _roundtrip(rows, cols, offset=0, limit=10) == rows


def _parquet(rows, columns):
    return write_parquet(rows, columns)


def test_distinct_values_sorted_unique_no_nulls():
    cols = [{"id": "c0", "type": "string"}]
    rows = [{"c0": v} for v in ["B", "A", "B", None, "C", "A"]]
    out = distinct_values(_parquet(rows, cols), "c0")
    assert out == {"values": ["A", "B", "C"], "truncated": False}


def test_distinct_values_search_is_case_insensitive():
    cols = [{"id": "c0", "type": "string"}]
    rows = [{"c0": v} for v in ["Alpha", "beta", "Gamma", "alto"]]
    out = distinct_values(_parquet(rows, cols), "c0", search="al")
    # ILIKE %al% matches "Alpha" and "alto" regardless of case.
    assert out["values"] == ["Alpha", "alto"]
    assert out["truncated"] is False


def test_distinct_values_truncates_at_limit():
    cols = [{"id": "c0", "type": "string"}]
    rows = [{"c0": f"v{i:03d}"} for i in range(10)]
    out = distinct_values(_parquet(rows, cols), "c0", limit=3)
    assert out["values"] == ["v000", "v001", "v002"]
    assert out["truncated"] is True


def test_distinct_values_numeric_column_cast_to_string():
    cols = [{"id": "c0", "type": "number"}]
    rows = [{"c0": 2}, {"c0": 1}, {"c0": 2}]
    out = distinct_values(_parquet(rows, cols), "c0")
    # Values come back as strings (dropdown labels); numeric order via VARCHAR sort.
    assert out["values"] == ["1.0", "2.0"]


def test_distinct_values_empty_col_id():
    cols = [{"id": "c0", "type": "string"}]
    out = distinct_values(_parquet([{"c0": "a"}], cols), "")
    assert out == {"values": [], "truncated": False}


def test_query_page_categorical_values_filter():
    # A checkbox-list (categorical) filter: `values` matches any, regardless of type.
    cols = [{"id": "c0", "type": "string"}]
    rows = [{"c0": v} for v in ["ICU", "ER", "Ward", "ICU"]]
    path = _parquet(rows, cols)
    page, total = query_page(
        path, {"c0": "string"},
        filters=[{"colId": "c0", "values": ["ICU", "ER"]}],
    )
    assert total == 3
    assert sorted(r["c0"] for r in page) == ["ER", "ICU", "ICU"]


def test_query_page_categorical_values_on_number_column():
    cols = [{"id": "c0", "type": "number"}]
    rows = [{"c0": 5}, {"c0": 6}, {"c0": 7}]
    path = _parquet(rows, cols)
    # 5/7 stored as 5.0/7.0 → match by their VARCHAR form.
    page, total = query_page(
        path, {"c0": "number"},
        filters=[{"colId": "c0", "values": ["5.0", "7.0"]}],
    )
    assert total == 2


def test_query_page_empty_values_is_noop():
    cols = [{"id": "c0", "type": "string"}]
    path = _parquet([{"c0": "a"}, {"c0": "b"}], cols)
    _, total = query_page(path, {"c0": "string"}, filters=[{"colId": "c0", "values": []}])
    assert total == 2
