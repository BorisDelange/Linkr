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


def _all_dataset_paths(data: dict) -> set[str]:
    """Every dataset file's logical mark key (datasets/<dsPath>) — reproduces the
    old "include all data" behavior for tests that previously passed include_data=True."""
    from app.services.project_export import _dataset_path

    by_id = {f["id"]: f for f in data["datasetFiles"]}
    return {
        f"datasets/{_dataset_path(f, by_id)}"
        for f in data["datasetFiles"]
        if f.get("type") == "file"
    }


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
        versioned_data_files=_all_dataset_paths(data) if include_data else set(),
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


def test_machine_local_bindings_stripped_from_project_json():
    """ide_path/datasets_path are machine-local server bindings and must never
    travel with an export (project.json), so an import reconfigures them."""
    data = json.loads((_GOLDEN / "input.json").read_text())
    project = {
        **data["project"],
        "idePath": "/home/x",
        "scriptsPath": "/home/x/my_study",
        "datasetsPath": "/home/x/content/data",
    }
    tree = build_project_tree(
        project=project,
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
        attachments=[],
        attachment_blobs={},
        versioned_data_files=set(),
    )
    project_json = json.loads(tree["project.json"].decode())
    assert "idePath" not in project_json
    assert "scriptsPath" not in project_json
    assert "datasetsPath" not in project_json


def test_slugify_matches_ts():
    # Same rules as the TS slugify: NFD strip, lowercase, non-alnum → '-', trim.
    assert _slugify("Projet démo") == "projet-demo"
    assert _slugify("cohort.csv") == "cohort-csv"
    assert _slugify("  ") == "export"
    assert _slugify("A/B — C") == "a-b-c"


def test_gitignore_ignores_data_by_default():
    # Nothing marked (and the golden ships no dataset blobs) → data files ignored
    # everywhere (datasets/ AND scripts/), no !path exceptions. The marked case
    # (exceptions after the ignore rules) is covered by the raw-file test below.
    unmarked = _build_tree(include_data=False)[".gitignore"].decode()
    assert unmarked.startswith("**/*.csv")
    assert unmarked.endswith(".cache/\n")
    assert "!" not in unmarked


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
        versioned_data_files={"datasets/cohort.csv"},
    )
    assert tree["datasets/cohort/cohort.csv"] == b"age,sex\n30,M\n"
    assert "datasets/cohort/_data.json" not in tree
    assert "!datasets/cohort/cohort.csv" in tree[".gitignore"].decode()


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
        versioned_data_files={"datasets/computed.csv"},
    )
    assert tree["datasets/computed/computed.csv"] == b'a,b\n1,"x,y"\n2,z'


def test_reference_csv_under_scripts_ignored_unless_marked():
    # A data file living under scripts/ (e.g. a reference CSV) is gitignored by
    # default like any data file; marking its scripts/ tree path re-includes it.
    ref = {"id": "r1", "name": "concepts.csv", "type": "file", "parentId": "fold", "path": "reference/concepts.csv"}
    fold = {"id": "fold", "name": "reference", "type": "folder", "parentId": None, "path": "reference"}
    common = dict(
        project={"uid": "p", "name": {"en": "P"}},
        organization=None,
        pipelines=[], cohorts=[], connections=[], dashboards=[],
        dataset_files=[], dataset_analyses={}, dataset_data={}, dataset_raw_files={},
        attachments=[], attachment_blobs={},
    )
    # Unmarked: the file is still written (it's IDE content) but ignored, no exception.
    unmarked = build_project_tree(ide_files=[fold, {**ref, "content": "a,b"}], versioned_data_files=set(), **common)
    assert unmarked["scripts/reference/concepts.csv"] == b"a,b"
    assert "!scripts/reference/concepts.csv" not in unmarked[".gitignore"].decode()
    # Marked (key = scripts/ tree path): the !path exception is emitted.
    marked = build_project_tree(
        ide_files=[fold, {**ref, "content": "a,b"}],
        versioned_data_files={"scripts/reference/concepts.csv"},
        **common,
    )
    assert "!scripts/reference/concepts.csv" in marked[".gitignore"].decode()


def test_excluded_code_file_omitted_from_tree():
    # Code files are versioned by default; an excludedFiles entry (its scripts/ tree
    # path) omits the file from the tree AND from scripts/_tree.json entirely — must
    # match buildProjectZip / the sidebar "unmarked" badge so it never leaves the box.
    kept = {"id": "k1", "name": "keep.sql", "type": "file", "parentId": None, "content": "SELECT 1", "path": "keep.sql"}
    dropped = {"id": "d1", "name": "secret.py", "type": "file", "parentId": None, "content": "TOKEN = 1", "path": "secret.py"}
    common = dict(
        project={"uid": "p", "name": {"en": "P"}},
        organization=None,
        pipelines=[], cohorts=[], connections=[], dashboards=[],
        dataset_files=[], dataset_analyses={}, dataset_data={}, dataset_raw_files={},
        attachments=[], attachment_blobs={},
        versioned_data_files=set(),
    )
    tree = build_project_tree(
        ide_files=[kept, dropped],
        excluded_files={"scripts/secret.py"},
        **common,
    )
    assert tree["scripts/keep.sql"] == b"SELECT 1"
    assert "scripts/secret.py" not in tree
    meta_names = [m["name"] for m in json.loads(tree["scripts/_tree.json"])]
    assert "keep.sql" in meta_names
    assert "secret.py" not in meta_names


def test_scripts_tree_omitted_when_every_code_file_excluded():
    # When the only script is excluded, don't emit a useless `scripts/_tree.json: []`
    # (the whole scripts/ section drops out). Mirrors buildProjectZip.
    only = {"id": "d1", "name": "test.py", "type": "file", "parentId": None, "content": "x = 1", "path": "test.py"}
    tree = build_project_tree(
        project={"uid": "p", "name": {"en": "P"}},
        organization=None,
        ide_files=[only],
        pipelines=[], cohorts=[], connections=[], dashboards=[],
        dataset_files=[], dataset_analyses={}, dataset_data={}, dataset_raw_files={},
        attachments=[], attachment_blobs={},
        versioned_data_files=set(),
        excluded_files={"scripts/test.py"},
    )
    assert "scripts/_tree.json" not in tree
    assert "scripts/test.py" not in tree


def test_gitignore_exception_escapes_metacharacters():
    # A marked filename containing gitignore metachars ([ ] * ? # !) must be escaped
    # in the !path exception, else git reads it as a pattern and the re-inclusion
    # silently misses the file (the failure mode the feature prevents). Byte-parity
    # with the TS gitignoreEscapePath.
    ref = {"id": "r1", "name": "a[1]*.csv", "type": "file", "parentId": None, "content": "x", "path": "a[1]*.csv"}
    tree = build_project_tree(
        project={"uid": "p", "name": {"en": "P"}},
        organization=None,
        ide_files=[ref],
        pipelines=[], cohorts=[], connections=[], dashboards=[],
        dataset_files=[], dataset_analyses={}, dataset_data={}, dataset_raw_files={},
        attachments=[], attachment_blobs={},
        versioned_data_files={"scripts/a[1]*.csv"},
    )
    assert r"!scripts/a\[1\]\*.csv" in tree[".gitignore"].decode()
