"""Parity + behaviour of the label column filter (label_filter_sql).

The cases come from the SAME fixture the frontend test consumes
(apps/web/src/lib/label-filter.fixture.json): the TS buildLabelFilterSql must
emit the same SQL text, and that SQL, run here on DuckDB, keeps the rows the
in-memory labelMatcher keeps.
"""

import json
from pathlib import Path

import duckdb
import pytest

from app.services.data import global_table_service as gts
from app.services.data.global_table_service import label_filter_sql

_FIXTURE = json.loads(
    (Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "label-filter.fixture.json").read_text()
)


@pytest.mark.parametrize("case", _FIXTURE["sqlCases"], ids=lambda c: c["term"])
def test_emits_the_frontend_sql(case):
    assert label_filter_sql(case["term"], case["column"], case["from"], case.get("alias")) == case["sql"]


def test_blank_term_is_no_filter():
    assert label_filter_sql("   ", "concept_name", "concepts") is None


@pytest.fixture(scope="module")
def con():
    c = duckdb.connect()
    c.execute("CREATE TABLE labels (concept_name VARCHAR)")
    c.executemany("INSERT INTO labels VALUES (?)", [[r] for r in _FIXTURE["rows"]])
    yield c
    c.close()


@pytest.mark.parametrize("case", _FIXTURE["filterCases"], ids=lambda c: c["term"])
def test_keeps_the_rows_labelmatcher_keeps(con, case):
    where = label_filter_sql(case["term"], "concept_name", "labels")
    rows = con.execute(f"SELECT concept_name FROM labels WHERE {where}").fetchall()
    assert sorted(r[0] for r in rows) == sorted(case["expected"])


def test_global_where_folds_names_but_keeps_the_code_a_substring():
    where = gts._where(
        {"sourceConceptName": "antecedant", "targetConceptName": "note", "sourceConceptCode": "a_b"},
        "flat",
    )
    assert label_filter_sql("antecedant", "source_concept_name", "g") in where
    assert label_filter_sql("note", "target_concept_name", "g") in where
    assert "LOWER(source_concept_code) LIKE LOWER('%a_b%')" in where
