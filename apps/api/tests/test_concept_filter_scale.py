"""A concept column filter on a 10-million-value column (the Concepts page's
Category on a large warehouse), through the server's concept-cache query path.

The SQL is the frontend's own: concept-queries.test.ts writes what the builders
emit to concept-filter-scale.fixture.json and fails when they drift from it.
Each query must answer within BUDGET_S, and the dropdown never receives more
than one page of values.
"""

import json
import time
from pathlib import Path

import duckdb
import pytest

from app.services.data.db_connect import query_cached_parquet

pytestmark = pytest.mark.slow

_SQL = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "web/src/features/projects/warehouse/concepts/concept-filter-scale.fixture.json"
    ).read_text()
)

ROWS = 10_000_000
FAMILIES = ["Bactériologie", "Biochimie", "Hématologie", "Mycologie", "Virologie"]
PAGE = 1000
# Generous for a shared CI runner; a laptop answers each in well under a second.
BUDGET_S = 5.0


@pytest.fixture(scope="module")
def cache(tmp_path_factory):
    """One concept per value: `<family> <n>`, every value distinct."""
    path = tmp_path_factory.mktemp("scale") / "concepts.parquet"
    families = ", ".join(f"'{f}'" for f in FAMILIES)
    duckdb.execute(
        f"COPY (SELECT range AS concept_id, 'c' || range AS concept_name,"
        f" ([{families}])[range % {len(FAMILIES)} + 1] || ' ' || (range // {len(FAMILIES)}) AS domain_id"
        f" FROM range({ROWS})) TO '{path}' (FORMAT PARQUET)"
    )
    return str(path)


def run(cache, key):
    start = time.perf_counter()
    rows = query_cached_parquet(cache, _SQL[key])
    elapsed = time.perf_counter() - start
    assert elapsed < BUDGET_S, f"{key}: {elapsed:.2f} s"
    return rows


def test_first_page_lists_one_page_and_counts_them_all(cache):
    rows = run(cache, "firstPage")
    assert len(rows) == PAGE
    assert rows[0]["total"] == ROWS


def test_search_counts_every_match_past_the_page(cache):
    rows = run(cache, "search")
    assert len(rows) == PAGE
    assert rows[0]["total"] == ROWS // len(FAMILIES)
    assert all(r["val"].startswith("Mycologie ") for r in rows)


def test_typo_falls_back_on_close_values(cache):
    rows = run(cache, "typo")
    assert rows
    assert all(r["val"].startswith("Mycologie ") for r in rows)


def test_search_matching_nothing_is_empty(cache):
    assert run(cache, "noMatch") == []


def test_match_value_filters_the_table(cache):
    rows = run(cache, "tablePage")
    assert len(rows) == 50
    assert all(r["domain_id"].startswith("Mycologie ") for r in rows)
    count = run(cache, "tableCount")
    assert count == [{"cnt": ROWS // len(FAMILIES) + 1}]
