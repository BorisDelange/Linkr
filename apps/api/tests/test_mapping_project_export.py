"""Byte-parity test for the server-side mapping-project export builder.

Reads the SAME golden fixture the frontend test consumes
(apps/web/src/lib/concept-mapping/__fixtures__/export-golden/mapping-project/),
so the Python builder and its TS twin can't drift. Mirrors the TS golden test
(export-golden.test.ts) and follows the parity pattern of test_column_id.py.
"""

import base64
import json
from pathlib import Path

from app.services.mapping_project_export import build_mapping_project_tree

_GOLDEN = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "src"
    / "lib"
    / "concept-mapping"
    / "__fixtures__"
    / "export-golden"
    / "mapping-project"
)
_EXPECTED = _GOLDEN / "expected"


def _build_tree() -> dict[str, bytes]:
    data = json.loads((_GOLDEN / "input.json").read_text())
    source_csv = base64.b64decode(data["sourceCsvBase64"])
    return build_mapping_project_tree(
        project=data["project"],
        mappings=data["mappings"],
        ranges=data["ranges"],
        entries=data["entries"],
        organization=data["organization"],
        source_csv=source_csv,
    )


def _expected_paths() -> list[str]:
    return sorted(
        str(p.relative_to(_EXPECTED)).replace("\\", "/")
        for p in _EXPECTED.rglob("*")
        if p.is_file()
    )


def test_tree_paths_match_golden():
    tree = _build_tree()
    assert sorted(tree.keys()) == _expected_paths()


def test_each_file_matches_golden_byte_for_byte():
    tree = _build_tree()
    for path in _expected_paths():
        expected = (_EXPECTED / path).read_bytes()
        assert tree[path] == expected, f"content mismatch for {path}"


def test_entries_sorted_by_code_point_matches_ts():
    """Python's native sorted() must give the SAME order as the TS export's
    compareCodePoints (the versioned order). '+'(0x2B) < '0'(0x30) < '|'(0x7C)."""
    from app.services.mapping_project_export import _compact_entries

    entries = [
        {
            "badgeLabel": "Rennes",
            "vocabularyId": "v",
            "conceptCode": "961400",
            "sourceConceptId": 3,
        },
        {
            "badgeLabel": "Rennes",
            "vocabularyId": "v",
            "conceptCode": "9614+1",
            "sourceConceptId": 2,
        },
        {
            "badgeLabel": "Rennes",
            "vocabularyId": "v",
            "conceptCode": "0000|",
            "sourceConceptId": 1,
        },
    ]
    codes = [row[2] for row in _compact_entries(entries)["entries"]]
    assert codes == ["0000|", "9614+1", "961400"]


def test_whole_float_matchscore_serializes_like_js():
    """JS JSON.stringify(1.0) === '1'; Python json.dumps(1.0) === '1.0'. A
    matchScore of 1.0/0.0 (exact/zero match) must emit the SAME bytes as the TS
    builder or a mixed-mode team gets a perpetual spurious diff. Fractions stay."""
    from app.services.mapping_project_export import _serialize_mappings

    out = _serialize_mappings([
        {"sourceConceptCode": "A", "matchScore": 1.0},
        {"sourceConceptCode": "B", "matchScore": 0.0},
        {"sourceConceptCode": "C", "matchScore": 0.85},
    ]).decode()
    assert '"matchScore": 1' in out and '"matchScore": 1.0' not in out
    assert '"matchScore": 0' in out and '"matchScore": 0.0' not in out
    assert '"matchScore": 0.85' in out


def test_parquet_source_is_converted_to_csv(tmp_path):
    """A project imported from .parquet used to have its raw bytes written under
    the source-concepts.csv name, so re-import decoded binary as text and the
    project came back with no source concepts. The tree must carry real CSV."""
    import duckdb

    from app.services.mapping_project_export import _as_csv_bytes

    pq = tmp_path / "src.parquet"
    duckdb.connect().execute(
        "COPY (SELECT * FROM (VALUES ('ccam', 'AAFA002', 'Exérèse, par craniotomie'))"
        " t(terminology_code, concept_code, concept_name))"
        f" TO '{pq}' (FORMAT PARQUET)"
    )
    out = _as_csv_bytes(pq.read_bytes()).decode()

    assert out.splitlines()[0] == "terminology_code,concept_code,concept_name"
    # the comma inside the label has to be quoted, not split the row
    assert out.splitlines()[1] == 'ccam,AAFA002,"Exérèse, par craniotomie"'


def test_real_csv_source_passes_through_untouched():
    """Only parquet is converted: a CSV source must keep its exact bytes, or every
    already-versioned project would show a whole-file diff on the next export."""
    from app.services.mapping_project_export import _as_csv_bytes

    csv = b"terminology_code,concept_code\nccam,AAFA002"
    assert _as_csv_bytes(csv) == csv


def test_database_project_with_an_extracted_csv_still_exports_it():
    """A database project whose Source concepts tab has run carries the same flat
    CSV a file import would have produced, and it must travel: gating on
    sourceType == 'file' dropped it, so the re-imported project had no source
    concepts at all. Twin of readsFromFlatSource (mapping-status.ts)."""
    csv = b"terminology,concept_code\nd_items,220045"
    tree = build_mapping_project_tree(
        project={
            "id": "p1",
            "name": "MIMIC-IV demo",
            "sourceType": "database",
            "fileSourceData": {
                "fileName": "source-concepts.csv",
                "rows": [],
                "columns": ["terminology", "concept_code"],
                "totalRowCount": 1,
            },
        },
        mappings=[],
        ranges=[],
        entries=[],
        organization=None,
        source_csv=csv,
    )
    assert tree["source-concepts.csv"] == csv


def test_database_project_without_a_flat_source_exports_no_csv():
    """The other side of the gate: a database project that never ran the
    extraction has no flat source, so there is nothing to write."""
    tree = build_mapping_project_tree(
        project={"id": "p1", "name": "Live", "sourceType": "database"},
        mappings=[],
        ranges=[],
        entries=[],
        organization=None,
        source_csv=None,
    )
    assert "source-concepts.csv" not in tree
