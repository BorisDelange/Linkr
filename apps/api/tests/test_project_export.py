"""Byte-parity test for the server-side project export builder.

Reads the SAME golden fixture the frontend test consumes
(apps/web/src/lib/__fixtures__/export-golden/project/), so the Python builder and
its TS twin (project-export-golden.test.ts) can't drift. Mirrors the mapping
project golden test (test_mapping_project_export.py).
"""

import base64
import json
from pathlib import Path

from app.services.export_layout import ENTITY_MANIFEST
from app.services.project_export import (
    _canonical_parse_options,
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
        patient_dashboards=data.get("patientDashboards"),
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
    project_json = json.loads(tree[ENTITY_MANIFEST].decode())
    assert "idePath" not in project_json
    assert "scriptsPath" not in project_json
    assert "datasetsPath" not in project_json


def _tree_with(project: dict, databases: list[dict] | None):
    data = json.loads((_GOLDEN / "input.json").read_text())
    return build_project_tree(
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
        databases=databases,
    )


def test_database_pointers_derived_from_the_linked_ids():
    """A published entity.json had accumulated the same pointer three times, plus
    one to a database the project was no longer linked to. The pointers are
    derived from linkedDataSourceIds, so what travels is what the project's
    Databases page shows: each database once, and nothing it dropped."""
    data = json.loads((_GOLDEN / "input.json").read_text())
    project = {
        **data["project"],
        "linkedDataSourceIds": ["db-a", "db-b", "db-a", "db-a"],
        # The stale list the bug used to publish verbatim.
        "linkedDataSourceRefs": [
            {"lineageId": "lin-a", "entityId": "mimic-iv-demo"},
            {"lineageId": "lin-gone", "entityId": "mimic-iv-demo-omop"},
            {"lineageId": "lin-a", "entityId": "mimic-iv-demo"},
            {"lineageId": "lin-a", "entityId": "mimic-iv-demo"},
        ],
    }
    databases = [
        {"id": "db-a", "lineageId": "lin-a", "entityId": "mimic-iv-demo", "name": {"en": "A"}},
        {"id": "db-b", "lineageId": "lin-b", "entityId": "eicu", "name": {"en": "B"}},
    ]
    project_json = json.loads(_tree_with(project, databases)[ENTITY_MANIFEST].decode())
    assert project_json["linkedDataSourceRefs"] == [
        {"lineageId": "lin-a", "entityId": "mimic-iv-demo", "label": {"en": "A"}},
        {"lineageId": "lin-b", "entityId": "eicu", "label": {"en": "B"}},
    ]
    # The local ids never travel — they address rows on this instance only.
    assert "linkedDataSourceIds" not in project_json


def test_database_pointers_kept_when_the_databases_are_not_available():
    """A caller that cannot hand in the databases (no access, or an older call
    site) must not have every pointer dropped from the export."""
    data = json.loads((_GOLDEN / "input.json").read_text())
    stored = [{"lineageId": "lin-a", "entityId": "mimic-iv-demo"}]
    project = {
        **data["project"],
        "linkedDataSourceIds": ["db-a"],
        "linkedDataSourceRefs": stored,
    }
    project_json = json.loads(_tree_with(project, None)[ENTITY_MANIFEST].decode())
    assert project_json["linkedDataSourceRefs"] == stored


def test_slugify_matches_ts():
    # Same rules as the TS slugify: NFD strip, lowercase, non-alnum → '-', trim.
    assert _slugify("Projet démo") == "projet-demo"
    assert _slugify("cohort.csv") == "cohort-csv"
    assert _slugify("  ") == "export"
    assert _slugify("A/B — C") == "a-b-c"


def test_canonical_parse_options_sorts_keys_and_nested_maps():
    # parseOptions written in either order canonicalises identically, so the
    # exported datasets/_tree.json doesn't churn on write history (front/back twin).
    a = _canonical_parse_options(
        {"columnTypes": {"col_z": "number", "col_a": "string"}, "columnFilterMode": {"col_b": "list"}}
    )
    b = _canonical_parse_options(
        {"columnFilterMode": {"col_b": "list"}, "columnTypes": {"col_a": "string", "col_z": "number"}}
    )
    assert list(a.keys()) == ["columnFilterMode", "columnTypes"]
    assert a == b
    assert list(a["columnTypes"].keys()) == ["col_a", "col_z"]


def test_dataset_tree_parse_options_order_independent():
    # The exported datasets/_tree.json bytes are identical regardless of the order
    # parseOptions keys were stored in.
    data = json.loads((_GOLDEN / "input.json").read_text())
    df = next(f for f in data["datasetFiles"] if f.get("parseOptions"))
    reversed_opts = dict(reversed(list(df["parseOptions"].items())))
    variant = [
        {**f, "parseOptions": reversed_opts} if f["id"] == df["id"] else f
        for f in data["datasetFiles"]
    ]
    common = dict(
        project=data["project"], organization=data["organization"], ide_files=data["ideFiles"],
        pipelines=data["pipelines"], cohorts=data["cohorts"], connections=data["connections"],
        dashboards=data["dashboards"], dataset_analyses=data["datasetAnalyses"],
        dataset_data=data["datasetData"], dataset_raw_files=data["datasetRawFiles"],
        attachments=[], attachment_blobs={}, versioned_data_files=set(),
    )
    original = build_project_tree(dataset_files=data["datasetFiles"], **common)
    variant_tree = build_project_tree(dataset_files=variant, **common)
    assert original["datasets/_tree.json"] == variant_tree["datasets/_tree.json"]


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


def test_two_cohorts_sharing_a_name_both_survive():
    # The loss this guards: the filename is the slug of the name and nothing
    # enforces unique cohort names, so two "Adults" wrote cohorts/adults.json
    # twice and the second silently destroyed the first. Must match
    # buildCohortKeyMap's suffixing exactly, or the two writers disagree.
    tree = build_project_tree(
        project={"uid": "p", "name": {"en": "P"}},
        organization=None,
        ide_files=[],
        pipelines=[],
        cohorts=[
            {"id": "co-b", "name": "Adults", "level": "visit"},
            {"id": "co-a", "name": "Adults", "level": "patient"},
        ],
        connections=[],
        dashboards=[],
        dataset_files=[],
        dataset_analyses={},
        dataset_data={},
        dataset_raw_files={},
        attachments=[],
        attachment_blobs={},
        versioned_data_files=set(),
    )
    assert "cohorts/adults.json" in tree
    assert "cohorts/adults#2.json" in tree
    # Suffix handed out in id order, not input order, so the pair keeps its
    # filenames across exports rather than swapping them.
    assert json.loads(tree["cohorts/adults.json"])["level"] == "patient"
    assert json.loads(tree["cohorts/adults#2.json"])["level"] == "visit"


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
    # The tree is keyed by path (relative to scripts/), carrying no id/name.
    meta_paths = [m["path"] for m in json.loads(tree["scripts/_tree.json"])]
    assert "keep.sql" in meta_paths
    assert "secret.py" not in meta_paths


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


def test_stale_marked_and_excluded_paths_pruned_from_project_json():
    # A file marked "to version" (versionedDataFiles) or "do not version"
    # (excludedFiles) and then DELETED must drop out of project.json — else it
    # lingers forever with no UI to clear it. Only paths whose file still exists
    # (in scripts/ or datasets/) survive.
    keep_code = {"id": "k", "name": "keep.py", "type": "file", "parentId": None, "content": "x", "path": "keep.py"}
    kept_ds = {"id": "d1", "name": "here.csv", "type": "file", "parentId": None, "path": "here.csv"}
    project = {
        "uid": "p",
        "name": {"en": "P"},
        "config": {
            "theme": "dark",
            "versionedDataFiles": ["datasets/here.csv", "datasets/gone.csv", "scripts/gone.csv"],
            "excludedFiles": ["scripts/keep.py", "scripts/vanished.R"],
        },
    }
    tree = build_project_tree(
        project=project,
        organization=None,
        ide_files=[keep_code],
        pipelines=[], cohorts=[], connections=[], dashboards=[],
        dataset_files=[kept_ds], dataset_analyses={}, dataset_data={}, dataset_raw_files={},
        attachments=[], attachment_blobs={},
        versioned_data_files={"datasets/here.csv"},
    )
    cfg = json.loads(tree[ENTITY_MANIFEST].decode())["config"]
    # Existing files survive; dead entries are dropped; unrelated keys untouched.
    assert cfg["versionedDataFiles"] == ["datasets/here.csv"]
    assert cfg["excludedFiles"] == ["scripts/keep.py"]
    assert cfg["theme"] == "dark"


def test_ide_data_source_id_stripped_from_config_but_pointer_kept():
    # The IDE's selected database is stored as this instance's local UUID beside a
    # portable pointer. The id addresses nothing on another instance and would
    # churn the diff, so it never travels; the ref does. Mirrors the same strip in
    # buildProjectZip -- front and server must emit the same bytes here.
    project = {
        "uid": "p",
        "name": {"en": "P"},
        "config": {
            "theme": "dark",
            "ideDataSourceId": "12994fb1-24c2-4aa4-8c6d-ba92b6b55646",
            "ideDataSourceRef": {"lineageId": "db-lin-1", "entityId": "mimic"},
        },
    }
    tree = build_project_tree(
        project=project,
        organization=None,
        ide_files=[], pipelines=[], cohorts=[], connections=[], dashboards=[],
        dataset_files=[], dataset_analyses={}, dataset_data={}, dataset_raw_files={},
        attachments=[], attachment_blobs={},
        versioned_data_files=set(),
    )
    cfg = json.loads(tree[ENTITY_MANIFEST].decode())["config"]
    assert "ideDataSourceId" not in cfg
    assert cfg["ideDataSourceRef"] == {"lineageId": "db-lin-1", "entityId": "mimic"}
    assert cfg["theme"] == "dark"


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


def _board_tree(tabs: list[dict]) -> dict[str, bytes]:
    """Export one patient board carrying the given tabs, in the order given."""
    board = {"id": "b1", "name": {"en": "Bedside"}, "projectUid": "p"}
    return build_project_tree(
        project={"uid": "p", "name": {"en": "P"}},
        organization=None,
        ide_files=[], pipelines=[], cohorts=[], connections=[], dashboards=[],
        dataset_files=[], dataset_analyses={}, dataset_data={}, dataset_raw_files={},
        attachments=[], attachment_blobs={},
        versioned_data_files=set(),
        patient_dashboards=[{"patientDashboard": board, "tabs": tabs, "widgets": []}],
    )


def test_same_named_tabs_export_the_same_bytes_whatever_the_row_order():
    # The collision suffix (#<displayOrder>) is assigned while iterating the tab
    # list, so an unordered DB read made two tabs called "Labs" swap keys between
    # exports — a phantom git diff, and ids that flip on reimport. The service
    # now orders by (display_order, id); this pins that the export depends on
    # nothing else.
    a = {"id": "t1", "name": {"en": "Labs"}, "displayOrder": 0, "patientDashboardId": "b1"}
    b = {"id": "t2", "name": {"en": "Labs"}, "displayOrder": 1, "patientDashboardId": "b1"}

    forward = _board_tree([a, b])["patient-dashboards/bedside.json"]
    reverse = _board_tree([b, a])["patient-dashboards/bedside.json"]

    assert forward == reverse, "tab order changed the exported bytes"
    keys = {t["key"] for t in json.loads(forward.decode())["tabs"]}
    assert keys == {"bedside/labs", "bedside/labs#1"}


def test_a_widget_with_no_layout_keys_like_its_ts_twin():
    # JS interpolates a missing coordinate as `undefined`; Python used to write
    # `None`, so a partial/legacy layout keyed differently on the two engines —
    # precisely the case where byte-parity matters most.
    tab = {"id": "t1", "name": {"en": "Labs"}, "displayOrder": 0, "patientDashboardId": "b1"}
    widget = {"id": "w1", "name": {"en": "W"}, "tabId": "t1", "layout": {}, "pluginId": "p"}
    tree = build_project_tree(
        project={"uid": "p", "name": {"en": "P"}},
        organization=None,
        ide_files=[], pipelines=[], cohorts=[], connections=[], dashboards=[],
        dataset_files=[], dataset_analyses={}, dataset_data={}, dataset_raw_files={},
        attachments=[], attachment_blobs={},
        versioned_data_files=set(),
        patient_dashboards=[
            {
                "patientDashboard": {"id": "b1", "name": {"en": "Bedside"}, "projectUid": "p"},
                "tabs": [tab],
                "widgets": [widget],
            }
        ],
    )
    key = json.loads(tree["patient-dashboards/bedside.json"].decode())["widgets"][0]["key"]
    assert key.endswith("@undefined,undefined"), key
