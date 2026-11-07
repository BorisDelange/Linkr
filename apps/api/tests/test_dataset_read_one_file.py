"""A dataset read opens the one file its path names: `read_parquet` expands `*`,
`?` and `[` against the disk, so a name read as a pattern must not reach a file
the path check never saw."""

import os

import duckdb
import pytest

from app.services.data import dataset_parser, dataset_rows

COLUMNS = [{"id": "col_outside", "name": "outside"}]


@pytest.fixture
def datasets(tmp_path):
    root = tmp_path / "datasets"
    root.mkdir()
    outside = tmp_path / "outside_root"
    outside.mkdir()
    duckdb.execute(f"COPY (SELECT 'OUTSIDE-DUMMY' AS outside) TO '{outside / 'x.parquet'}' (FORMAT PARQUET)")
    os.symlink(outside, root / "link")
    planted = root / "[l]ink"
    planted.mkdir()
    duckdb.execute(f"COPY (SELECT 'PLANTED' AS planted) TO '{planted / 'x.parquet'}' (FORMAT PARQUET)")
    return root


def _reads(fn) -> str:
    try:
        return repr(fn())
    except (duckdb.Error, OSError) as exc:
        return f"refused: {type(exc).__name__}"


@pytest.mark.parametrize("read", [
    lambda p: dataset_rows.read_parquet(p),
    lambda p: dataset_rows.query_page(p, {"col_outside": "string"}, columns=COLUMNS),
    lambda p: dataset_rows.column_stats(p, "col_outside", "string", columns=COLUMNS),
    lambda p: dataset_rows.distinct_values(p, "col_outside", columns=COLUMNS),
    lambda p: dataset_parser.parquet_schema(p),
])
def test_a_dataset_name_read_as_a_pattern_reaches_no_other_file(datasets, read):
    out = _reads(lambda: read(datasets / "[l]ink" / "x.parquet"))
    assert "OUTSIDE" not in out and "outside" not in out


def test_a_dataset_still_reads_its_own_file(tmp_path):
    path = tmp_path / "plain.parquet"
    duckdb.execute(f"COPY (SELECT 1 AS a UNION ALL SELECT 2) TO '{path}' (FORMAT PARQUET)")
    cols = [{"id": "col_a", "name": "a"}]
    assert dataset_rows.read_parquet(path) == [{"a": 1}, {"a": 2}]
    rows, total = dataset_rows.query_page(path, {"col_a": "number"}, columns=cols, sort={"colId": "col_a", "dir": "desc"})
    assert total == 2 and rows[0] == {"col_a": 2}
    assert dataset_rows.column_stats(path, "col_a", "number", columns=cols)["count"] == 2
    assert dataset_rows.distinct_values(path, "col_a", columns=cols)["values"] == ["1", "2"]
    assert dataset_parser.parquet_schema(path)[1] == 2
