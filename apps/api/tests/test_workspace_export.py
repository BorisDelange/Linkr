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
from app.services.entity_docs import entity_doc_files, strip_entity_docs
from app.services.workspace_export import (
    _sanitize_connection_config,
    _slugify,
    _strip_instance_fields,
    build_workspace_tree,
)
from app.services.workspace_export_assemble import _to_path_tree, _tree_path

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


def _stripped(meta: dict) -> dict:
    """What the assembler stores as an entity's `meta`: docs split out to their own
    files (only the licence identity stays) and instance-local fields dropped."""
    return strip_entity_docs(_strip_instance_fields(meta))


def _file_sub_tree(meta_name: str, meta: dict, files: list[dict], fk: str) -> dict:
    """Full sql-collection / etl-pipeline folder, as _sql_collection_sub_tree does."""
    tree: dict[str, bytes] = {meta_name: None}
    tree[meta_name] = _json_bytes(_stripped(meta))
    tree.update(entity_doc_files("", meta))
    by_id = {f["id"]: f for f in files}
    tree["_tree.json"] = _json_bytes(_to_path_tree(files, fk))
    for f in files:
        if f["type"] == "file" and f.get("content") is not None:
            tree[_tree_path(f, by_id)] = str(f["content"]).encode("utf-8")
    return tree


def _json_bytes(value) -> bytes:
    from app.core.json_export import export_json

    return export_json(value)


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

    # The six sections below mirror what the DB assembler passes in: metadata
    # already stripped, heavy folders pre-built. They used to be empty lists,
    # which is why every divergence in them went unnoticed.
    schemas = [
        {"meta": _stripped(sp), "git": sp.get("gitRemoteConfig")}
        for sp in data["schemaPresets"]
    ]
    sql_collections = [
        {
            "meta": _stripped(c),
            "git": c.get("gitRemoteConfig"),
            "folder": c.get("entityId") or _slugify(c["name"].get("en") or c["id"]),
            "id": c["id"],
            "name": c.get("name"),
            "createdAt": c.get("createdAt"),
            **(
                {}
                if c.get("gitRemoteConfig")
                else {
                    "sub_tree": _file_sub_tree(
                        "_collection.json",
                        c,
                        data["sqlScriptFiles"].get(c["id"], []),
                        "collectionId",
                    )
                }
            ),
        }
        for c in data["sqlCollections"]
    ]
    etl_pipelines = [
        {
            "meta": _stripped(p),
            "git": p.get("gitRemoteConfig"),
            "folder": p.get("entityId") or _slugify(p["name"].get("en") or p["id"]),
            "id": p["id"],
            "name": p.get("name"),
            "createdAt": p.get("createdAt"),
            **(
                {}
                if p.get("gitRemoteConfig")
                else {
                    "sub_tree": _file_sub_tree(
                        "_pipeline.json",
                        p,
                        data["etlFiles"].get(p["id"], []),
                        "pipelineId",
                    )
                }
            ),
        }
        for p in data["etlPipelines"]
    ]
    dq_rule_sets = [
        {
            "meta": _stripped(rs),
            "checks": data["dqChecks"].get(rs["id"], []),
            "git": rs.get("gitRemoteConfig"),
            "folder": rs.get("entityId") or _slugify(rs["name"].get("en") or rs["id"]),
        }
        for rs in data["dqRuleSets"]
    ]
    catalogs = [
        {"meta": _stripped(c), "git": c.get("gitRemoteConfig")}
        for c in data["dataCatalogs"]
    ]
    concept_sets = [_strip_instance_fields(cs) for cs in data["conceptSets"]]

    return build_workspace_tree(
        workspace=workspace,
        organization=org,
        projects=projects,
        wiki_pages=data["wikiPages"],
        wiki_attachments=wiki_atts,
        wiki_attachment_blobs=wiki_blobs,
        schemas=schemas,
        data_sources=data["dataSources"],
        sql_collections=sql_collections,
        etl_pipelines=etl_pipelines,
        dq_rule_sets=dq_rule_sets,
        mapping_projects=mapping_projects,
        concept_sets=concept_sets,
        id_ranges=_to_portable_ranges(data["ranges"]),
        catalogs=catalogs,
        service_mappings=data["serviceMappings"],
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


# --- connection config sanitizer -------------------------------------------
#
# Twin of sanitize-connection-config.test.ts. These assertions ARE the security
# boundary: a workspace export can be pushed to a public git repo and indexed by
# the catalog, so anything surviving this function is world-readable.

_FULL_CONFIG = {
    "engine": "postgres",
    "host": "db.chu-rennes.fr",
    "port": 5432,
    "database": "omop_prod",
    "schema": "cdm",
    "username": "bdelange",
    "password": "hunter2",
    "token": "ghp_deadbeef",
    "baseUrl": "https://fhir.example.org",
    "authType": "bearer",
    "fileId": "f1",
    "fileIds": ["f1", "f2"],
    "fileNames": ["patients.parquet"],
    "fileHandleIds": ["h1"],
}


def test_sanitizer_keeps_only_the_engine():
    assert _sanitize_connection_config(_FULL_CONFIG) == {"engine": "postgres"}


def test_sanitizer_leaks_no_credential_host_or_file_reference():
    out = json.dumps(_sanitize_connection_config(_FULL_CONFIG))
    for secret in (
        "hunter2", "ghp_deadbeef", "bdelange",
        "db.chu-rennes.fr", "5432", "omop_prod", "cdm",
        "fhir.example.org", "bearer",
        "f1", "f2", "patients.parquet", "h1",
    ):
        assert secret not in out


def test_sanitizer_withholds_an_unknown_field():
    # A denylist would publish every one of these. The allowlist is the point.
    assert _sanitize_connection_config({
        "engine": "postgres",
        "sslCert": "-----BEGIN CERTIFICATE-----",
        "dsn": "postgres://user:pw@host/db",
        "apiKey": "sk-live-1234",
        "connectionString": "Server=x;Password=y",
    }) == {"engine": "postgres"}


def test_sanitizer_keeps_structural_flags_and_drops_none():
    assert _sanitize_connection_config(
        {"engine": "duckdb", "inMemory": True, "managed": False}
    ) == {"engine": "duckdb", "inMemory": True, "managed": False}
    # None is dropped on both sides, or the two builders emit different bytes.
    assert _sanitize_connection_config({"engine": "duckdb", "inMemory": None}) == {"engine": "duckdb"}


def test_sanitizer_emits_keys_in_allowlist_order():
    out = _sanitize_connection_config({"managed": True, "inMemory": True, "engine": "duckdb"})
    assert list(out.keys()) == ["engine", "inMemory", "managed"]
