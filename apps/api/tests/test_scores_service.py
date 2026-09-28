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


def test_append_rows_creates_then_merges_without_overwriting(tmp_path):
    row = {
        "source_vocabulary_id": "REA", "source_concept_code": "hr", "concept_id": 3027018,
        "method": "ai/qwen3", "score": 0.9, "equivalence": "skos:closeMatch", "comment": "first",
    }
    first = str(tmp_path / "1.parquet")
    assert svc.append_rows(None, [row, row], first) == (1, 1)

    second = str(tmp_path / "2.parquet")
    changed = {**row, "comment": "second"}
    other = {**row, "concept_id": 3027019}
    assert svc.append_rows(first, [changed, other], second) == (1, 1)
    rows = svc.query_scores(second, "REA", "hr")
    assert sorted((r["concept_id"], r["comment"]) for r in rows) == [(3027018, "first"), (3027019, "first")]


def test_append_rows_keeps_legacy_file_columns(tmp_path):
    legacy = _write_parquet(
        [{"source_vocabulary_id": "LOINC", "source_concept_code": "1", "concept_id": "5",
          "method": "semantic/biolord", "score": "0.7"}],
        ["source_vocabulary_id", "source_concept_code", "concept_id", "method", "score"],
    )
    out = str(tmp_path / "out.parquet")
    new = {"source_vocabulary_id": "LOINC", "source_concept_code": "1", "concept_id": 6,
           "method": "ai/m", "score": 0.8, "concept_set_uid": "u1"}
    assert svc.append_rows(legacy, [new], out) == (1, 0)
    index = svc.build_index("p", out)
    assert index["rowCount"] == 2
    assert index["categorySourceKeys"]["agentic"] == ["LOINC::1"]
    assert index["categorySourceKeys"]["data_dictionary"] == ["LOINC::1"]


def test_remove_rows_by_method_and_source(tmp_path):
    base = {"source_vocabulary_id": "REA", "concept_id": 1, "score": 0.5}
    rows = [
        {**base, "source_concept_code": "a", "method": "ai/x"},
        {**base, "source_concept_code": "b", "method": "ai/x"},
        {**base, "source_concept_code": "a", "method": "semantic/biolord"},
    ]
    path = str(tmp_path / "s.parquet")
    svc.append_rows(None, rows, path)
    out = str(tmp_path / "o.parquet")
    assert svc.remove_rows(path, ["ai/x"], [("REA", "a")], out) == (1, 2)
    assert sorted((r["source_concept_code"], r["method"]) for r in
                  svc.query_scores(out, "REA", "a") + svc.query_scores(out, "REA", "b")) == [
        ("a", "semantic/biolord"), ("b", "ai/x")]
    assert svc.remove_rows(path, ["ai/x", "semantic/biolord"], None, str(tmp_path / "e.parquet")) == (3, 0)


def test_query_by_targets(tmp_path):
    base = {"source_vocabulary_id": "REA", "method": "semantic/biolord"}
    path = str(tmp_path / "s.parquet")
    svc.append_rows(None, [
        {**base, "source_concept_code": "a", "concept_id": 1, "score": 0.9},
        {**base, "source_concept_code": "b", "concept_id": 1, "score": 0.4},
        {**base, "source_concept_code": "c", "concept_id": 2, "score": 0.8},
        {**base, "source_concept_code": "d", "concept_id": 1, "score": 0.7, "method": "ai/x"},
    ], path)
    got = svc.query_by_targets(path, [1], 0.5, None, 10)
    assert [(r["source_concept_code"], r["score"]) for r in got] == [("a", 0.9), ("d", 0.7)]
    assert [r["source_concept_code"] for r in svc.query_by_targets(path, [1, 2], 0, ["semantic/biolord"], 10)] == ["a", "c", "b"]


# --- Per-method CSV (the versioned form) --------------------------------------

_CSV_COLUMNS = ["source_vocabulary_id", "source_concept_code", "concept_id", "method", "score", "equivalence", "comment"]


def _scores_file() -> str:
    return _write_parquet(
        [
            {"source_vocabulary_id": "LOINC", "source_concept_code": "1-2", "concept_id": 3012345,
             "method": "ai/claude-opus-4-8", "score": 0.81234, "equivalence": "skos:exactMatch",
             "comment": 'good, "really"'},
            {"source_vocabulary_id": "LOINC", "source_concept_code": "1-2", "concept_id": 42,
             "method": "semantic/biolord", "score": 0.5, "equivalence": "skos:exactMatch", "comment": None},
            {"source_vocabulary_id": "LOINC", "source_concept_code": "0-1", "concept_id": 43,
             "method": "semantic/biolord", "score": 1.0, "equivalence": "skos:exactMatch", "comment": ""},
        ],
        _CSV_COLUMNS,
    )


def test_csv_path_rule_matches_the_format_package():
    # Twin of scoreCsvPath / scoreMethodOfPath in packages/linkr-format/src/layout.ts.
    assert svc.csv_path_for_method("ai/claude-opus-4-8") == "similarity-scores/ai/claude-opus-4-8.csv"
    assert svc.method_for_csv_path("similarity-scores/semantic/biolord.csv") == "semantic/biolord"
    for bad in ["../etc", "ai/..", "ai//x", ".hidden", "ai/.x", "a b", "ai\\x", "", "ai\n", "ai/x\n"]:
        assert svc.csv_path_for_method(bad) is None, bad
    assert svc.method_for_csv_path("similarity-scores/../x.csv") is None
    assert svc.method_for_csv_path("similarity-scores.parquet") is None


def test_write_method_csv_is_sorted_rounded_and_drops_blank_columns():
    path = _scores_file()
    out = Path(tempfile.mkdtemp())
    assert svc.write_method_csv(path, "semantic/biolord", str(out / "b.csv")) == 2
    # comment is blank for every biolord row, so the column is not written at all.
    assert (out / "b.csv").read_text() == (
        "source_vocabulary_id,source_concept_code,concept_id,score,equivalence\n"
        "LOINC,0-1,43,1.0000,skos:exactMatch\n"
        "LOINC,1-2,42,0.5000,skos:exactMatch\n"
    )
    svc.write_method_csv(path, "ai/claude-opus-4-8", str(out / "a.csv"))
    assert (out / "a.csv").read_text().splitlines()[1] == 'LOINC,1-2,3012345,0.8123,skos:exactMatch,"good, ""really"""'


def test_method_stats_estimates_each_csv():
    stats = svc.method_stats(_scores_file())
    assert [(s["method"], s["rowCount"], s["versionable"]) for s in stats] == [
        ("ai/claude-opus-4-8", 1, True), ("semantic/biolord", 2, True),
    ]
    assert all(s["csvBytes"] > 0 for s in stats)


def test_merge_method_csvs_replaces_only_the_named_methods():
    path = _scores_file()
    tmp = Path(tempfile.mkdtemp())
    csv = tmp / "b.csv"
    csv.write_text("source_vocabulary_id,source_concept_code,concept_id,score\nLOINC,9,7,0.25\n")
    assert svc.merge_method_csvs(path, [("semantic/biolord", str(csv))], str(tmp / "m.parquet")) == 2
    rows = duckdb.sql(
        f"SELECT method, source_concept_code, concept_id, score, equivalence FROM '{tmp / 'm.parquet'}' ORDER BY method"
    ).fetchall()
    assert rows == [
        ("ai/claude-opus-4-8", "1-2", 3012345, 0.81234, "skos:exactMatch"),
        ("semantic/biolord", "9", 7, 0.25, None),
    ]


def test_csv_round_trip_keeps_the_rows():
    path = _scores_file()
    tmp = Path(tempfile.mkdtemp())
    svc.write_method_csv(path, "semantic/biolord", str(tmp / "b.csv"))
    assert svc.merge_method_csvs(None, [("semantic/biolord", str(tmp / "b.csv"))], str(tmp / "m.parquet")) == 2
    svc.write_method_csv(str(tmp / "m.parquet"), "semantic/biolord", str(tmp / "b2.csv"))
    assert (tmp / "b2.csv").read_bytes() == (tmp / "b.csv").read_bytes()


def test_merge_method_csvs_refuses_an_empty_csv_list():
    # An empty list would filter every row out and the caller would delete the file.
    tmp = Path(tempfile.mkdtemp())
    try:
        svc.merge_method_csvs(_scores_file(), [], str(tmp / "m.parquet"))
    except ValueError:
        pass
    else:
        raise AssertionError("expected a ValueError")


def test_merge_method_csvs_refuses_a_csv_without_key_columns():
    tmp = Path(tempfile.mkdtemp())
    (tmp / "b.csv").write_text("source_concept_code,score\n1,0.5\n")
    try:
        svc.merge_method_csvs(None, [("semantic/biolord", str(tmp / "b.csv"))], str(tmp / "m.parquet"))
    except ValueError as e:
        assert "source_vocabulary_id" in str(e)
    else:
        raise AssertionError("expected a ValueError")
