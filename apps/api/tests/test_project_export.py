"""Byte-parity test for the server-side project export builder.

Reads the SAME golden fixture the frontend test consumes
(apps/web/src/lib/__fixtures__/export-golden/project/), so the Python builder and
its TS twin (project-export-golden.test.ts) can't drift. Mirrors the mapping
project golden test (test_mapping_project_export.py).
"""

import base64
import json
from pathlib import Path

from app.services.project_export import (
    _slugify,
    build_project_tree,
)

_GOLDEN = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "src"
    / "lib"
    / "__fixtures__"
    / "export-golden"
    / "project"
)
_EXPECTED = _GOLDEN / "expected"


def _build_tree(include_data: bool = False) -> dict[str, bytes]:
    data = json.loads((_GOLDEN / "input.json").read_text())
    atts = [{k: v for k, v in a.items() if k != "dataBase64"} for a in data["attachments"]]
    blobs = {a["id"]: base64.b64decode(a["dataBase64"]) for a in data["attachments"]}
    return build_project_tree(
        project=data["project"],
        organization=data["organization"],
        ide_files=data["ideFiles"],
        pipelines=data["pipelines"],
        cohorts=data["cohorts"],
        connections=data["connections"],
        dashboards=data["dashboards"],
        dataset_files=data["datasetFiles"],
        dataset_analyses=data["datasetAnalyses"],
        dataset_data=data["datasetData"],
        dataset_raw_files=data["datasetRawFiles"],
        attachments=atts,
        attachment_blobs=blobs,
        include_data_files=include_data,
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


def test_slugify_matches_ts():
    # Same rules as the TS slugify: NFD strip, lowercase, non-alnum → '-', trim.
    assert _slugify("Projet démo") == "projet-demo"
    assert _slugify("cohort.csv") == "cohort-csv"
    assert _slugify("  ") == "export"
    assert _slugify("A/B — C") == "a-b-c"


def test_gitignore_toggles_on_include_data():
    without = _build_tree(include_data=False)[".gitignore"].decode()
    assert without.startswith("datasets/**/*.csv")
    assert without.endswith(".cache/\n")

    with_data = _build_tree(include_data=True)[".gitignore"].decode()
    assert with_data == ".cache/\n"


def test_include_data_writes_raw_file_verbatim_without_sidecar():
    # Server-mode parity: rows are never shipped (paginated on demand), so the raw
    # file is written verbatim with NO _data.json sidecar (and no reconstructed CSV).
    data = json.loads((_GOLDEN / "input.json").read_text())
    df = next(f for f in data["datasetFiles"] if f["id"] == "cohort.csv")
    raw = {"blob": b"age,sex\n30,M\n", "fileName": "cohort.csv"}
    tree = build_project_tree(
        project=data["project"],
        organization=None,
        ide_files=[],
        pipelines=[],
        cohorts=[],
        connections=[],
        dashboards=[],
        dataset_files=[df],
        dataset_analyses={},
        dataset_data={},
        dataset_raw_files={df["id"]: raw},
        attachments=[],
        attachment_blobs={},
        include_data_files=True,
    )
    assert tree["datasets/cohort/cohort.csv"] == b"age,sex\n30,M\n"
    assert "datasets/cohort/_data.json" not in tree


def test_computed_dataset_reconstructs_csv_when_no_raw_file():
    # No raw file but rows present (a computed dataset) → reconstructed CSV via
    # datasetToCsv (header uses column NAMES, cells keyed by column ids).
    df = {
        "id": "computed.csv",
        "name": "computed.csv",
        "type": "file",
        "parentId": None,
        "path": "computed.csv",
        "columns": [
            {"id": "col_a", "name": "a", "type": "number"},
            {"id": "col_b", "name": "b", "type": "string"},
        ],
    }
    rows = [{"col_a": 1, "col_b": "x,y"}, {"col_a": 2, "col_b": "z"}]
    tree = build_project_tree(
        project={"uid": "p", "name": {"en": "P"}},
        organization=None,
        ide_files=[],
        pipelines=[],
        cohorts=[],
        connections=[],
        dashboards=[],
        dataset_files=[df],
        dataset_analyses={},
        dataset_data={df["id"]: rows},
        dataset_raw_files={},
        attachments=[],
        attachment_blobs={},
        include_data_files=True,
    )
    assert tree["datasets/computed/computed.csv"] == b'a,b\n1,"x,y"\n2,z'
