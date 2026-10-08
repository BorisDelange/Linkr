"""Dashboard filter predicates applied server-side (injection._python_filter_code /
_r_filter_code): both twins must keep the same rows as the client's applyFilters."""

import json
import shutil
import subprocess

import pandas as pd
import pytest

from app.services.execution import injection

requires_r = pytest.mark.skipif(shutil.which("Rscript") is None, reason="Rscript not installed")

ROWS = {
    "grp": ["a", "b", "a", None],
    "flag": [True, False, True, False],
    "at": ["2024-06-29T08:00:00", "2024-06-30T18:30:00", None, "2024-07-01T00:00:00"],
    "n": [1.0, 2.0, 3.0, 4.0],
}


def _python_keep(filters: list[dict]) -> list[float]:
    ns = {"_pd": pd, "dataset": pd.DataFrame(ROWS)}
    exec(injection._python_filter_code(filters), ns)
    return ns["dataset"]["n"].tolist()


def _r_keep(filters: list[dict], tmp_path) -> list[float]:
    data = tmp_path / "rows.json"
    data.write_text(json.dumps(ROWS))
    script = tmp_path / "f.R"
    script.write_text(
        f"rows <- jsonlite::fromJSON({injection._r_str(data.as_posix())})\n"
        "dataset <- data.frame(grp = rows$grp, flag = rows$flag, at = rows$at, n = rows$n)\n"
        f"{injection._r_filter_code(filters)}\n"
        "cat(dataset$n, sep = ',')\n"
    )
    out = subprocess.run(["Rscript", "--vanilla", str(script)], capture_output=True, text=True, check=True)
    return [float(v) for v in out.stdout.split(",") if v]


CASES = [
    ([{"colId": "grp", "kind": "string", "alternatives": [{"op": "in", "values": ["a"]}]}], [1.0, 3.0]),
    ([{"colId": "flag", "kind": "string", "alternatives": [{"op": "in", "values": ["true"]}]}], [1.0, 3.0]),
    # A day bound keeps the whole end day; a missing date never matches a from-only filter.
    ([{"colId": "at", "kind": "date", "alternatives": [{"op": "between", "min": "2024-06-29", "max": "2024-06-30"}]}], [1.0, 2.0]),
    ([{"colId": "at", "kind": "date", "alternatives": [{"op": "between", "min": "2024-06-30"}]}], [2.0, 4.0]),
    ([{"colId": "n", "kind": "number", "alternatives": [{"op": "between", "min": 2, "max": 3.5}]}], [2.0, 3.0]),
    ([{"colId": "n", "kind": "number", "alternatives": [{"op": "between", "min": "1); stop('x'"}]}], []),
    ([{"colId": "n", "kind": "number", "alternatives": [{"op": "between", "max": float("nan")}]}], []),
]


@pytest.mark.parametrize(("filters", "expected"), CASES)
def test_python_filters(filters, expected):
    assert _python_keep(filters) == expected


@requires_r
@pytest.mark.parametrize(("filters", "expected"), CASES)
def test_r_filters_match_python(filters, expected, tmp_path):
    assert _r_keep(filters, tmp_path) == expected


def test_number_bounds_are_spliced_as_float_literals():
    code = injection._r_filter_code(
        [{"colId": "n", "kind": "number", "alternatives": [{"op": "between", "min": "1); system('id'", "max": "5"}]}]
    )
    assert "system" not in code
    assert "(.col <= 5.0)" in code


def test_datetime_column_filters_on_its_date_part():
    ts = pd.to_datetime(pd.Series(["2024-06-30 18:30", None, "2024-07-01 00:00"]))
    ns = {"_pd": pd, "dataset": pd.DataFrame({"at": ts, "n": [1, 2, 3]})}
    exec(injection._python_filter_code(
        [{"colId": "at", "kind": "date", "alternatives": [{"op": "between", "max": "2024-06-30"}]}]
    ), ns)
    assert ns["dataset"]["n"].tolist() == [1]
