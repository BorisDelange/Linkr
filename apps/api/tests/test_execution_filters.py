"""Dashboard filter predicates applied server-side (injection._python_filter_code /
_r_filter_code): both twins must keep the same rows as the client's applyFilters."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pandas as pd
import pytest

from app.services.execution import injection

requires_r = pytest.mark.skipif(shutil.which("Rscript") is None, reason="Rscript not installed")


def _r_has_arrow() -> bool:
    if shutil.which("Rscript") is None:
        return False
    probe = subprocess.run(
        ["Rscript", "--vanilla", "-e", "library(arrow)"], capture_output=True, text=True
    )
    return probe.returncode == 0


requires_r_arrow = pytest.mark.skipif(not _r_has_arrow(), reason="Rscript or R arrow not installed")

ROWS = {
    "grp": ["a", "b", "a", None, "b"],
    "flag": [True, False, True, False, False],
    "at": ["2024-06-29T08:00:00", "2024-06-30T18:30:00", None, "2024-07-01T00:00:00", ""],
    "n": [1.0, 2.0, 3.0, 4.0, 5.0],
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
    # An empty string is a missing date, as on the client, even under a to-only bound.
    ([{"colId": "at", "kind": "date", "alternatives": [{"op": "between", "max": "2024-06-30"}]}], [1.0, 2.0]),
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


@requires_r_arrow
def test_r_naive_parquet_timestamp_filters_on_its_utc_wall_clock(tmp_path):
    pa = pytest.importorskip("pyarrow")
    pq = pytest.importorskip("pyarrow.parquet")
    path = tmp_path / "ts.parquet"
    at = pd.to_datetime(pd.Series(["2024-06-30 23:30", "2024-07-01 00:30"])).astype("datetime64[us]")
    pq.write_table(
        pa.table({"at": pa.array(at, type=pa.timestamp("us")), "n": [1.0, 2.0]}), path
    )
    columns = [{"id": "at", "name": "at", "type": "date"}, {"id": "n", "name": "n", "type": "number"}]
    filters = [{"colId": "at", "kind": "date", "alternatives": [{"op": "between", "max": "2024-06-30"}]}]
    script = tmp_path / "f.R"
    script.write_text(injection.r_preamble_from(path.as_posix(), columns, filters) + "cat(dataset$n, sep = ',')\n")
    out = subprocess.run(
        ["Rscript", "--vanilla", str(script)],
        capture_output=True, text=True, check=True, env={**os.environ, "TZ": "Europe/Paris"},
    )
    assert out.stdout.strip() == "1"


@requires_r_arrow
def test_r_date_columns_read_as_utc_whatever_the_host_tz(tmp_path):
    pa = pytest.importorskip("pyarrow")
    pq = pytest.importorskip("pyarrow.parquet")
    path = tmp_path / "dates.parquet"
    naive = pd.to_datetime(pd.Series(["2024-06-30 23:30"])).astype("datetime64[us]")
    pq.write_table(pa.table({
        "iso": ["2024-06-30T23:30:00"],
        "spaced": ["2024-06-30 23:30:00"],
        "day": ["2024-06-30"],
        "ts": pa.array(naive, type=pa.timestamp("us")),
    }), path)
    columns = [{"id": c, "name": c, "type": "date"} for c in ("iso", "spaced", "day", "ts")]
    script = tmp_path / "d.R"
    script.write_text(
        injection.r_preamble_from(path.as_posix(), columns)
        + "for (.c in colnames(dataset)) cat(format(dataset[[.c]], '%Y-%m-%d %H:%M:%S %Z'), "
        "as.numeric(dataset[[.c]]), sep = '|', fill = TRUE)\n"
    )
    out = subprocess.run(
        ["Rscript", "--vanilla", str(script)],
        capture_output=True, text=True, check=True, env={**os.environ, "TZ": "Europe/Paris"},
    )
    assert out.stdout.split() == [
        "2024-06-30", "23:30:00", "UTC|1719790200",
        "2024-06-30", "23:30:00", "UTC|1719790200",
        "2024-06-30", "00:00:00", "UTC|1719705600",
        "2024-06-30", "23:30:00", "UTC|1719790200",
    ]


MIXED_DATES = [
    "2024-06-29",
    "2024-06-29T08:00:00",
    "2024-06-29 08:15",
    "",
    None,
    "2024-06-29T08:00:00+02:00",
    "2024-06-29T08:00:00.250Z",
    "30/06/2024",
    "2024-06-29T08:00:00junk",
]
# Epoch seconds pandas format="ISO8601" gives; blank and non-ISO values are missing.
MIXED_EPOCHS = [
    1719619200.0, 1719648000.0, 1719648900.0, None, None,
    1719640800.0, 1719648000.25, None, None,
]


def _mixed_dates_parquet(tmp_path):
    pa = pytest.importorskip("pyarrow")
    pq = pytest.importorskip("pyarrow.parquet")
    path = tmp_path / "mixed.parquet"
    pq.write_table(pa.table({"at": pa.array(MIXED_DATES, type=pa.string())}), path)
    return path


def test_python_date_columns_parse_each_iso_value_to_naive_utc(tmp_path):
    path = _mixed_dates_parquet(tmp_path)
    ns: dict = {}
    exec(injection.python_preamble_from(path.as_posix(), [{"id": "at", "name": "at", "type": "date"}]), ns)  # noqa: S102
    at = ns["dataset"]["at"]
    assert at.dt.tz is None
    got = [None if pd.isna(v) else v.timestamp() for v in at.dt.tz_localize("UTC")]
    assert got == MIXED_EPOCHS


@requires_r_arrow
def test_r_date_columns_parse_like_pandas(tmp_path):
    path = _mixed_dates_parquet(tmp_path)
    script = tmp_path / "m.R"
    script.write_text(
        injection.r_preamble_from(path.as_posix(), [{"id": "at", "name": "at", "type": "date"}])
        + "cat(attr(dataset$at, 'tzone'), ifelse(is.na(dataset$at), 'NA', format(as.numeric(dataset$at), nsmall = 2)), sep = '|')\n"
    )
    out = subprocess.run(
        ["Rscript", "--vanilla", str(script)],
        capture_output=True, text=True, check=True, env={**os.environ, "TZ": "Europe/Paris"},
    )
    tz, *values = out.stdout.strip().split("|")
    assert tz == "UTC"
    assert [None if v == "NA" else float(v) for v in values] == MIXED_EPOCHS


def test_browser_r_date_parser_is_the_server_one():
    ts = (
        Path(__file__).resolve().parents[2]
        / "web/src/features/projects/lab/datasets/analysis-executor.ts"
    ).read_text()
    browser = ts.split("export const R_AS_UTC = String.raw`", 1)[1].split("`", 1)[0]
    assert browser == injection.R_AS_UTC
