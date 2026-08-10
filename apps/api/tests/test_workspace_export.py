"""Byte-parity test for the server-side workspace export builder.

Reads the SAME golden fixture the frontend test consumes
(apps/web/src/lib/__fixtures__/export-golden/workspace/), so the Python builder and
its TS twin (workspace-export-golden.test.ts) can't drift. Mirrors the project +
mapping-project golden tests.

The pure ``build_workspace_tree`` composes already-built sub-trees for the two heavy
sections; this test builds those sub-trees exactly as the DB assembler would (full
project via ``build_project_tree``, full mapping folder via
``build_mapping_project_tree`` minus its standalone ``.gitignore``) and feeds the
whole thing in — so it exercises the same composition the assembler performs.
"""

import base64
import json
from pathlib import Path

from app.services.mapping_project_export import build_mapping_project_tree
from app.services.project_export import build_project_tree
from app.services.workspace_export import (
    _slugify,
    _strip_instance_fields,
    build_workspace_tree,
)

_GOLDEN = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "src"
    / "lib"
    / "__fixtures__"
    / "export-golden"
    / "workspace"
)
_EXPECTED = _GOLDEN / "expected"


def _org_snapshot(org: dict) -> dict:
    return {k: v for k, v in org.items() if k != "updatedAt"}


def _to_portable_ranges(ranges: list[dict]) -> list[dict]:
    out = [
        {
            "badgeLabel": r["badgeLabel"],
            "rangeStart": r["rangeStart"],
            "rangeEnd": r["rangeEnd"],
            "nextId": r["nextId"],
            "totalConcepts": r["totalConcepts"],
        }
        for r in ranges
    ]
    out.sort(key=lambda r: r["badgeLabel"])
    return out


def _full_project_sub_tree(data: dict, project: dict, org: dict) -> dict[str, bytes]:
    """The nested full-project tree, as build_project_tree_from_db would produce it
    with the inherited workspace org (project has no own org → inline the workspace's)."""
    return build_project_tree(
        project=project,
        organization=org,
        ide_files=data["projectIdeFiles"].get(project["uid"], []),
        pipelines=[],
        cohorts=[],
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


def _clean_mapping_meta(mp: dict) -> dict:
    tree = build_mapping_project_tree(
        project=mp, mappings=[], ranges=[], entries=[], organization=None, source_csv=None
    )
    return json.loads(tree["project.json"].decode("utf-8"))


def _mapping_sub_tree(data: dict, mp: dict) -> dict[str, bytes]:
    mappings = data["mappings"]
    ranges = _to_portable_ranges(data["ranges"])
    entries = [
        {
            "badgeLabel": e["badgeLabel"],
            "vocabularyId": e["vocabularyId"],
            "conceptCode": e["conceptCode"],
            "sourceConceptId": e["sourceConceptId"],
        }
        for e in data["entries"]
    ]
    source_csv = base64.b64decode(data["sourceCsvBase64"])
    tree = build_mapping_project_tree(
        project=mp,
        mappings=mappings,
        ranges=ranges,
        entries=entries,
        organization=None,
        source_csv=source_csv,
    )
    tree.pop(".gitignore", None)
    return tree


def _build_tree() -> dict[str, bytes]:
    data = json.loads((_GOLDEN / "input.json").read_text())
    workspace = data["workspace"]
    org = data["organization"]

    projects = []
    for p in data["projects"]:
        git = p.get("gitRemoteConfig")
        folder = p.get("projectId") or _slugify(p["name"].get("en") or "project")
        entry = {"meta": p, "git": git, "folder": folder, "readme": p.get("readme")}
        if not git:
            entry["sub_tree"] = _full_project_sub_tree(data, p, org)
        projects.append(entry)

    mapping_projects = []
    for mp in data["mappingProjects"]:
        git = mp.get("gitRemoteConfig")
        folder = mp.get("entityId") or _slugify(mp["name"].get("en") or mp["id"])
        entry = {
            "meta": _clean_mapping_meta(mp),
            "git": git,
            "folder": folder,
            "id": mp["id"],
            "entityId": mp.get("entityId"),
            "name": mp.get("name"),
        }
        if not git:
            entry["sub_tree"] = _mapping_sub_tree(data, mp)
        mapping_projects.append(entry)

    wiki_atts = [{k: v for k, v in a.items() if k != "dataBase64"} for a in data["wikiAttachments"]]
    wiki_blobs = {a["id"]: base64.b64decode(a["dataBase64"]) for a in data["wikiAttachments"]}

    return build_workspace_tree(
        workspace=workspace,
        organization=org,
        projects=projects,
        wiki_pages=data["wikiPages"],
        wiki_attachments=wiki_atts,
        wiki_attachment_blobs=wiki_blobs,
        schemas=[],
        data_sources=data["dataSources"],
        sql_collections=[],
        etl_pipelines=[],
        dq_rule_sets=[],
        mapping_projects=mapping_projects,
        id_ranges=_to_portable_ranges(data["ranges"]),
        catalogs=[],
        service_mappings=[],
        plugins=data["userPlugins"],
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


def test_org_snapshot_helper_matches_fixture():
    # The root organization.json uses stripInstanceFields (drops updatedAt); the
    # inline project org uses orgSnapshot (also drops only updatedAt). Both keep
    # createdAt — guard the distinction the golden encodes.
    data = json.loads((_GOLDEN / "input.json").read_text())
    root = json.loads((_EXPECTED / "organization.json").read_bytes())
    assert "updatedAt" not in root
    assert root["createdAt"] == data["organization"]["createdAt"]
    assert _org_snapshot(data["organization"]) == {
        k: v for k, v in data["organization"].items() if k != "updatedAt"
    }
    assert "createdAt" in _strip_instance_fields(data["organization"])
