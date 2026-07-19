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
