"""Every query of the corpus, on every engine, answers what DuckDB answers on the
Parquet: a query is never answered differently, only faster or slower.

Driven by the environment (run-matrix.mjs sets it):
  MATRIX_CORPUS   corpus.json from build-corpus.ts
  MATRIX_DATA     the Parquet folder, the reference
  MATRIX_WORK     where the duckdb / sqlite files were loaded
  MATRIX_ENGINES  comma-separated engines (engines.ALL), default parquet,duckdb,sqlite
  MATRIX_REPORT   where to write the timings and the differences (JSON)
"""

from __future__ import annotations

import atexit
import datetime
import json
import math
import os
import time
from pathlib import Path

import pytest

import engines
from app.services.data import db_connect

CORPUS = os.environ.get("MATRIX_CORPUS")
DATA = Path(os.environ.get("MATRIX_DATA", ""))
WORK = Path(os.environ.get("MATRIX_WORK", ""))
ENGINES = [e for e in os.environ.get("MATRIX_ENGINES", "parquet,duckdb,sqlite").split(",") if e]
REPORT = os.environ.get("MATRIX_REPORT")

pytestmark = pytest.mark.skipif(not CORPUS, reason="MATRIX_CORPUS is not set: run it through scripts/test-matrix.mjs")

QUERIES = json.loads(Path(CORPUS).read_text())["queries"] if CORPUS else []
_reference: dict[str, list[dict]] = {}
_report: list[dict] = []


def _parquet_files() -> list[tuple[str, str]]:
    return [(p.name, str(p)) for p in sorted(DATA.glob("*.parquet"))]


def _runner(engine: str):
    """A function running one SQL the way the app runs it on that engine."""
    if engine == "parquet":
        files, known = _parquet_files(), [p.stem for p in DATA.glob("*.parquet")]
        return lambda sql: db_connect.query_parquet_folder(files, known, sql)
    if engine in ("duckdb", "sqlite"):
        path = WORK / f"omop.{engine}"
        if not path.exists():
            pytest.skip(f"{path} was not loaded")
        return lambda sql: db_connect.query_file(engine, str(path), sql)
    if engine in ("postgresql", "mysql", "doris"):
        reach = engines.linkr_config(engine)
        if reach is None:
            pytest.skip(f"{engine}: no server configured (MATRIX_{engine.upper()}_HOST)")
        config, password = reach
        if engine == "doris":
            return lambda sql: db_connect.query_external(config, password, sql, pushdown=True)
        return lambda sql: db_connect.query_external(config, password, sql)
    pytest.skip(engines.NOT_SUPPORTED.get(engine, f"unknown engine {engine}"))


def _value(v):
    """One cell, in a form two engines agree on when they mean the same value."""
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, (int, float)):
        f = float(v)
        if math.isnan(f):
            return "NaN"
        return round(f, 6) if not f.is_integer() else int(f)
    if isinstance(v, str):
        # ISO timestamps: SQLite and the drivers differ on a trailing ".000000" or a "T".
        try:
            dt = datetime.datetime.fromisoformat(v)
            return dt.replace(microsecond=0).isoformat(sep=" ") if len(v) > 10 else v
        except ValueError:
            return v
    return str(v)


def _normal(rows: list[dict], ordered: bool) -> list[list]:
    out = [[(k, _value(v)) for k, v in row.items()] for row in rows]
    return out if ordered else sorted(out, key=lambda r: json.dumps(r, default=str))


def _run(engine: str, sql: str) -> tuple[list[dict], float]:
    run = _runner(engine)
    t0 = time.perf_counter()
    rows = run(sql)
    return rows, (time.perf_counter() - t0) * 1000


def _write_report() -> None:
    if REPORT and _report:
        Path(REPORT).write_text(json.dumps(_report, indent=1))


atexit.register(_write_report)


@pytest.mark.parametrize("engine", ENGINES)
@pytest.mark.parametrize("query", QUERIES, ids=[q["key"] for q in QUERIES])
def test_engine_answers_like_the_reference(engine: str, query: dict):
    entry = {"engine": engine, "key": query["key"], "source": query["source"]}
    _report.append(entry)
    try:
        rows, ms = _run(engine, query["sql"])
    except pytest.skip.Exception as e:
        entry["status"] = "skipped"
        entry["reason"] = str(e)
        raise
    except Exception as e:  # the engine refused the app's SQL: that is the finding
        entry["status"] = "error"
        entry["error"] = f"{type(e).__name__}: {str(e).split('Stack Trace')[0].strip()[:500]}"
        raise
    entry["ms"] = round(ms, 1)
    entry["rows"] = len(rows)

    if query["key"] not in _reference:
        _reference[query["key"]] = rows if engine == "parquet" else _run("parquet", query["sql"])[0]
    expected = _reference[query["key"]]
    got, want = _normal(rows, query["ordered"]), _normal(expected, query["ordered"])
    if got != want and not query["ordered"] and db_connect.MAX_QUERY_ROWS in (len(rows), len(expected)):
        # The app's row cap cut an unordered answer: each engine keeps a different
        # 10 000 rows, so the comparison says nothing about the query.
        entry["status"] = "capped"
        pytest.skip(f"{engine}: {query['key']} reached the {db_connect.MAX_QUERY_ROWS}-row cap unordered; not comparable")
    if got != want:
        entry["status"] = "different"
        diff = next((i for i, (a, b) in enumerate(zip(got, want)) if a != b), min(len(got), len(want)))
        entry["first_difference"] = {"row": diff, "got": got[diff:diff + 1], "want": want[diff:diff + 1], "rows": [len(got), len(want)]}
    else:
        entry["status"] = "same"
    assert got == want, f"{engine} answers {query['key']} differently from the Parquet reference: {entry['first_difference']}"
