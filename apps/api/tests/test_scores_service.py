"""Parity tests for server-side suggestion-scores reads (mirrors the browser's
scores-engine.ts / scores-parser.ts)."""

import tempfile
from pathlib import Path

import duckdb

from app.services.data import scores_service as svc


def _write_parquet(rows: list[dict], columns: list[str]) -> str:
    path = Path(tempfile.mkdtemp()) / "scores.parquet"
    con = duckdb.connect()
    try:
        values = ", ".join(
            "(" + ", ".join(_sql_literal(r.get(c)) for c in columns) + ")" for r in rows
        )
        col_list = ", ".join(columns)
        # Re-type numeric columns so read_parquet returns numbers, like a real file.
        select = ", ".join(_typed_select(c) for c in columns)
        con.execute(
            f"COPY (SELECT {select} FROM (VALUES {values}) AS v({col_list})) "
            f"TO '{path}' (FORMAT PARQUET)"
        )
    finally:
        con.close()
    return str(path)


def _typed_select(col: str) -> str:
    if col == "concept_id":
        return "CAST(concept_id AS BIGINT) AS concept_id"
    if col == "score":
        return "CAST(score AS DOUBLE) AS score"
    return col


def _sql_literal(v) -> str:
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


_FULL_COLS = [
    "source_vocabulary_id", "source_concept_code", "concept_id", "method",
    "score", "equivalence", "comment", "created_at", "concept_set_uid",
    "concept_set_source_repo",
]


def _sample_rows():
    return [
        {
            "source_vocabulary_id": "LOINC", "source_concept_code": "1234-5",
            "concept_id": "3000905", "method": "syntactic/jaro-winkler",
            "score": "0.9", "equivalence": "skos:exactMatch", "comment": None,
            "created_at": "2026-01-01", "concept_set_uid": None,
            "concept_set_source_repo": None,
        },
        {
            "source_vocabulary_id": "LOINC", "source_concept_code": "1234-5",
            "concept_id": "3000123", "method": "ai/gpt", "score": "0.8",
            "equivalence": None, "comment": "auto", "created_at": None,
            "concept_set_uid": "cs-1", "concept_set_source_repo": "repo-a",
        },
        {
            "source_vocabulary_id": "SNOMED", "source_concept_code": "44054006",
            "concept_id": "201826", "method": "semantic/biolord", "score": "0.7",
            "equivalence": "skos:exactMatch", "comment": None,
            "created_at": None, "concept_set_uid": None,
            "concept_set_source_repo": None,
        },
    ]


def test_validate_ok():
    path = _write_parquet(_sample_rows(), _FULL_COLS)
    ok, err = svc.validate(path)
    assert ok is True
    assert err is None


def test_validate_missing_columns():
    cols = ["source_vocabulary_id", "source_concept_code", "concept_id"]
    rows = [{c: "x" if c != "concept_id" else "1" for c in cols}]
    path = _write_parquet(rows, cols)
    ok, err = svc.validate(path)
    assert ok is False
    assert "method" in err and "score" in err


def test_build_index_shape():
    path = _write_parquet(_sample_rows(), _FULL_COLS)
    idx = svc.build_index("p1", path)
    assert idx["projectId"] == "p1"
    assert idx["rowCount"] == 3
    assert set(idx["methods"]) == {"syntactic/jaro-winkler", "ai/gpt", "semantic/biolord"}
    assert set(idx["sourceKeys"]) == {"LOINC::1234-5", "SNOMED::44054006"}
    cat = idx["categorySourceKeys"]
    assert cat["syntactic"] == ["LOINC::1234-5"]
    assert cat["agentic"] == ["LOINC::1234-5"]
    assert cat["semantic"] == ["SNOMED::44054006"]
    assert cat["data_dictionary"] == ["LOINC::1234-5"]  # the ai row has concept_set_uid


def test_query_scores_for_source():
    path = _write_parquet(_sample_rows(), _FULL_COLS)
    rows = svc.query_scores(path, "LOINC", "1234-5")
    assert len(rows) == 2
    methods = {r["method"] for r in rows}
    assert methods == {"syntactic/jaro-winkler", "ai/gpt"}
    ai = next(r for r in rows if r["method"] == "ai/gpt")
    assert ai["equivalence"] == "skos:exactMatch"  # null → default
    assert ai["concept_set_uid"] == "cs-1"
    assert ai["concept_set_source_repo"] == "repo-a"
    assert isinstance(ai["concept_id"], int)
    assert isinstance(ai["score"], float)


def test_query_scores_empty_args():
    path = _write_parquet(_sample_rows(), _FULL_COLS)
    assert svc.query_scores(path, "", "1234-5") == []
    assert svc.query_scores(path, "LOINC", "") == []


def test_legacy_parquet_without_concept_set_columns():
    cols = [
        "source_vocabulary_id", "source_concept_code", "concept_id", "method",
        "score", "equivalence", "comment", "created_at",
    ]
    rows = [{
        "source_vocabulary_id": "LOINC", "source_concept_code": "1234-5",
        "concept_id": "3000905", "method": "syntactic/jaro-winkler", "score": "0.9",
        "equivalence": "skos:exactMatch", "comment": None, "created_at": None,
    }]
    path = _write_parquet(rows, cols)
    idx = svc.build_index("p1", path)
    assert idx["categorySourceKeys"]["data_dictionary"] == []
    got = svc.query_scores(path, "LOINC", "1234-5")
    assert len(got) == 1
    assert got[0]["concept_set_uid"] is None
