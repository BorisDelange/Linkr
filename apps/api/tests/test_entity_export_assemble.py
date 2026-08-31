"""End-to-end parity for the standalone single-entity export builders.

For each versionable workspace child (SQL collection, ETL pipeline, DQ rule set,
data catalog, schema preset, user plugin), seed the SHARED golden input.json into
the DB, run the server standalone builder, and assert each produced file matches
expected/ byte for byte — the same golden the TS twin test uses. This proves the
server path matches the frontend build*Zip builders. Org is resolved from the
parent workspace's organization (workspaceId → workspace.organizationId → org).
"""

import json
from datetime import datetime
from pathlib import Path

import pytest

from app.models.data_catalog import DataCatalog
from app.models.dq_rule_set import DqCustomCheck, DqRuleSet
from app.models.etl_pipeline import EtlFile, EtlPipeline
from app.models.organization import Organization
from app.models.schema_preset import SchemaPreset
from app.models.sql_script import SqlScriptCollection, SqlScriptFile
from app.models.user import User
from app.models.user_plugin import UserPlugin
from app.models.workspace import Workspace
from app.services.workspace_export_assemble import (
    build_data_catalog_tree,
    build_dq_rule_set_tree,
    build_etl_pipeline_tree,
    build_schema_preset_tree,
    build_sql_collection_tree,
    build_user_plugin_tree,
)

_FIXTURES = Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "__fixtures__" / "export-golden"


def _dt(v: str) -> datetime:
    return datetime.fromisoformat(v.replace("Z", "+00:00"))


def _golden(kind: str) -> tuple[dict, Path]:
    d = _FIXTURES / kind
    return json.loads((d / "input.json").read_text()), d / "expected"


def _expected_paths(expected: Path) -> list[str]:
    return sorted(
        str(p.relative_to(expected)).replace("\\", "/")
        for p in expected.rglob("*")
        if p.is_file()
    )


def _assert_tree(tree: dict[str, bytes], expected: Path) -> None:
    assert sorted(tree.keys()) == _expected_paths(expected)
    for path in _expected_paths(expected):
        got = tree.get(path)
        assert got is not None, f"missing {path}"
        assert got.decode("utf-8") == (expected / path).read_text(), f"content mismatch for {path}"


async def _seed_ws_org(db, data) -> None:
    db.add(User(id=7, username="boris"))
    org = data["organization"]
    db.add(Organization(
        id=org["id"], name=org["name"], type=org["type"], location=org["location"],
        country=org["country"], website=org["website"], email=org["email"],
        custom_type=org["customType"], reference_id=org["referenceId"],
        custom_fields=org["customFields"], created_at=_dt(org["createdAt"]),
        updated_at=_dt(org["updatedAt"]),
    ))
    db.add(Workspace(id=data["workspace"]["id"], name={"en": "W"}, organization_id=org["id"]))
    await db.commit()


@pytest.mark.asyncio
async def test_sql_collection_matches_golden(db):
    data, expected = _golden("sql-collection")
    await _seed_ws_org(db, data)
    c = data["collection"]
    collection = SqlScriptCollection(
        id=c["id"], workspace_id=c["workspaceId"], entity_id=c["entityId"],
        name=c["name"], description=c["description"],
        default_data_source_id=c["defaultDataSourceId"],
        default_data_source_ref=c.get("defaultDataSourceRef"),
        git_remote_config=c["gitRemoteConfig"], created_by_id=c["createdById"],
        created_by=c["createdBy"], created_by_details=c["createdByDetails"],
        lineage_id=c["lineageId"], parent_lineage_id=c["parentLineageId"],
        version=c["version"], readme=c.get("readme"), license=c.get("license"),
        created_at=_dt(c["createdAt"]), updated_at=_dt(c["updatedAt"]),
        # Without this the filtering that decides WHICH files reach the repo goes
        # untested: every file would be kept and the golden would still pass.
        config=c.get("config"),
    )
    db.add(collection)
    await db.commit()
    for f in data["files"]:
        db.add(SqlScriptFile(
            id=f["id"], collection_id=f["collectionId"], name=f["name"], type=f["type"],
            parent_id=f["parentId"], content=f["content"], order=f["order"],
            data_source_id=f["dataSourceId"], created_at=f["createdAt"],
        ))
    await db.commit()
    _assert_tree(await build_sql_collection_tree(db, collection), expected)


@pytest.mark.asyncio
async def test_etl_pipeline_matches_golden(db):
    data, expected = _golden("etl-pipeline")
    await _seed_ws_org(db, data)
    p = data["pipeline"]
    pipeline = EtlPipeline(
        id=p["id"], workspace_id=p["workspaceId"], entity_id=p["entityId"],
        name=p["name"], description=p["description"],
        source_data_source_id=p["sourceDataSourceId"],
        target_data_source_id=p["targetDataSourceId"],
        mapping_project_id=p["mappingProjectId"], status=p["status"],
        source_data_source_ref=p.get("sourceDataSourceRef"),
        target_data_source_ref=p.get("targetDataSourceRef"),
        mapping_project_ref=p.get("mappingProjectRef"),
        last_run_at=p["lastRunAt"], last_run_duration_ms=p["lastRunDurationMs"],
        git_remote_config=p["gitRemoteConfig"], origin=p["origin"],
        created_by_id=p["createdById"], created_by=p["createdBy"],
        created_by_details=p["createdByDetails"], lineage_id=p["lineageId"],
        parent_lineage_id=p["parentLineageId"], version=p["version"],
        readme=p.get("readme"), license=p.get("license"),
        # Seeded so the per-file versioning marks are actually exercised: without
        # a config the fixture only ever covered the "no marks" branch, and the
        # filtering that decides WHICH files reach the repo went untested.
        config=p.get("config"),
        created_at=_dt(p["createdAt"]), updated_at=_dt(p["updatedAt"]),
    )
    db.add(pipeline)
    await db.commit()
    for f in data["files"]:
        db.add(EtlFile(
            id=f["id"], pipeline_id=f["pipelineId"], name=f["name"], type=f["type"],
            parent_id=f["parentId"], content=f["content"], language=f["language"],
            order=f["order"], data_source_id=f["dataSourceId"], disabled=f["disabled"],
            created_at=f["createdAt"],
        ))
    await db.commit()
    _assert_tree(await build_etl_pipeline_tree(db, pipeline), expected)


@pytest.mark.asyncio
async def test_etl_unmarked_data_file_leaves_no_tree_entry(db):
    """An unmarked data file is absent from _tree.json, not just from the zip.

    The server used to keep the entry and omit only the content, so a re-import
    created an empty mapping/source_to_concept_map.csv the repo never held — and
    every pull offered that phantom as an incoming change. Unlike a project's IDE
    folder, an ETL pipeline is never rebound to an existing directory: nothing can
    restore the content later, so a contentless node has nothing to survive for.
    buildEtlPipelineFolder (entity-io.ts) already dropped both; this is the twin.
    """
    data, _ = _golden("etl-pipeline")
    await _seed_ws_org(db, data)
    p = data["pipeline"]
    pipeline = EtlPipeline(
        id=p["id"], workspace_id=p["workspaceId"], entity_id=p["entityId"],
        name=p["name"], status=p["status"], created_at=_dt(p["createdAt"]),
        updated_at=_dt(p["updatedAt"]),
        config={"versionedDataFiles": ["mapping/kept.csv"]},
    )
    db.add(pipeline)
    await db.commit()
    db.add(EtlFile(
        id="fold", pipeline_id=pipeline.id, name="mapping", type="folder",
        parent_id=None, order=0, created_at=data["files"][0]["createdAt"],
    ))
    for fid, name, content in [
        ("keep", "kept.csv", "a,b\n1,2\n"),
        ("drop", "source_to_concept_map.csv", "a,b\n3,4\n"),
    ]:
        db.add(EtlFile(
            id=fid, pipeline_id=pipeline.id, name=name, type="file",
            parent_id="fold", content=content, order=0,
            created_at=data["files"][0]["createdAt"],
        ))
    await db.commit()

    tree = await build_etl_pipeline_tree(db, pipeline)
    paths = [n["path"] for n in json.loads(tree["scripts/_tree.json"])]
    # Tree paths stay pipeline-relative; only the files move. A marked mapping/
    # file keeps its root location because the generated script reads it by path.
    assert "mapping/kept.csv" in paths
    assert "mapping/source_to_concept_map.csv" not in paths
    assert "mapping/source_to_concept_map.csv" not in tree
    assert tree["mapping/kept.csv"] == b"a,b\n1,2\n"


@pytest.mark.asyncio
async def test_sql_collection_excluded_file_leaves_no_tree_entry(db):
    """An excluded script is absent from _tree.json, not just from the zip.

    Same rule and same reason as the ETL twin above: a tree naming a file the
    repo cannot contain re-imports as an empty script and makes every pull offer
    the phantom as an incoming change. A collection holds only `.sql`, so the
    default runs the other way — a script is committed unless excluded.
    """
    data, _ = _golden("sql-collection")
    await _seed_ws_org(db, data)
    c = data["collection"]
    collection = SqlScriptCollection(
        id=c["id"], workspace_id=c["workspaceId"], entity_id=c["entityId"],
        name=c["name"], description=c["description"],
        created_at=_dt(c["createdAt"]), updated_at=_dt(c["updatedAt"]),
        version=c["version"],
        config={"excludedFiles": ["queries/private.sql"]},
    )
    db.add(collection)
    await db.commit()
    db.add(SqlScriptFile(
        id="fold", collection_id=collection.id, name="queries", type="folder",
        parent_id=None, order=0, created_at=data["files"][0]["createdAt"],
    ))
    for fid, name, content in [
        ("keep", "cohort.sql", "SELECT 1;"),
        ("drop", "private.sql", "SELECT 2;"),
    ]:
        db.add(SqlScriptFile(
            id=fid, collection_id=collection.id, name=name, type="file",
            parent_id="fold", content=content, order=0,
            created_at=data["files"][0]["createdAt"],
        ))
    await db.commit()

    tree = await build_sql_collection_tree(db, collection)
    paths = [n["path"] for n in json.loads(tree["scripts/_tree.json"])]
    assert "queries/cohort.sql" in paths
    assert "queries/private.sql" not in paths
    assert "scripts/queries/private.sql" not in tree
    assert tree["scripts/queries/cohort.sql"] == b"SELECT 1;"


@pytest.mark.asyncio
async def test_dq_rule_set_matches_golden(db):
    data, expected = _golden("dq-rule-set")
    await _seed_ws_org(db, data)
    r = data["ruleSet"]
    rule_set = DqRuleSet(
        id=r["id"], workspace_id=r["workspaceId"], entity_id=r["entityId"],
        name=r["name"], description=r["description"], data_source_id=r["dataSourceId"],
        data_source_ref=r.get("dataSourceRef"),
        status=r["status"], last_run_at=r["lastRunAt"],
        last_run_duration_ms=r["lastRunDurationMs"], last_score=r["lastScore"],
        origin=r["origin"], created_by_id=r["createdById"], created_by=r["createdBy"],
        created_by_details=r["createdByDetails"], organization=r["organization"],
        lineage_id=r["lineageId"], parent_lineage_id=r["parentLineageId"],
        git_remote_config=r["gitRemoteConfig"], version=r["version"],
        readme=r.get("readme"), license=r.get("license"),
        created_at=_dt(r["createdAt"]), updated_at=_dt(r["updatedAt"]),
    )
    db.add(rule_set)
    await db.commit()
    for c in data["checks"]:
        db.add(DqCustomCheck(
            id=c["id"], rule_set_id=c["ruleSetId"], name=c["name"],
            description=c["description"], category=c["category"], severity=c["severity"],
            threshold=c["threshold"], sql=c["sql"], order=c["order"],
            created_at=_dt(c["createdAt"]), updated_at=_dt(c["updatedAt"]),
        ))
    await db.commit()
    _assert_tree(await build_dq_rule_set_tree(db, rule_set), expected)


@pytest.mark.asyncio
async def test_data_catalog_matches_golden(db):
    data, expected = _golden("data-catalog")
    await _seed_ws_org(db, data)
    c = data["catalog"]
    catalog = DataCatalog(
        id=c["id"], workspace_id=c["workspaceId"], entity_id=c["entityId"],
        name=c["name"], description=c["description"], data_source_id=c["dataSourceId"],
        dimensions=c["dimensions"], anonymization=c["anonymization"],
        category_column=c["categoryColumn"], subcategory_column=c["subcategoryColumn"],
        period_config=c["periodConfig"], status=c["status"], last_error=c["lastError"],
        last_computed_at=c["lastComputedAt"],
        last_compute_duration_ms=c["lastComputeDurationMs"],
        dcat_ap_metadata=c["dcatApMetadata"], origin=c["origin"],
        created_by_id=c["createdById"], created_by=c["createdBy"],
        created_by_details=c["createdByDetails"], organization=c["organization"],
        lineage_id=c["lineageId"], parent_lineage_id=c["parentLineageId"],
        git_remote_config=c["gitRemoteConfig"], version=c["version"],
        readme=c.get("readme"), license=c.get("license"),
        created_at=_dt(c["createdAt"]), updated_at=_dt(c["updatedAt"]),
    )
    db.add(catalog)
    await db.commit()
    _assert_tree(await build_data_catalog_tree(db, catalog), expected)


@pytest.mark.asyncio
async def test_schema_preset_matches_golden(db):
    data, expected = _golden("schema-preset")
    await _seed_ws_org(db, data)
    p = data["preset"]
    preset = SchemaPreset(
        preset_id=p["presetId"], id=p.get("id"), entity_id=p.get("entityId"),
        workspace_id=p["workspaceId"], mapping=p["mapping"],
        git_remote_config=p["gitRemoteConfig"], created_by_id=p["createdById"],
        created_by=p["createdBy"], created_by_details=p["createdByDetails"],
        version=p["version"], readme=p.get("readme"), license=p.get("license"),
        created_at=_dt(p["createdAt"]), updated_at=_dt(p["updatedAt"]),
    )
    db.add(preset)
    await db.commit()
    _assert_tree(await build_schema_preset_tree(db, preset), expected)


@pytest.mark.asyncio
async def test_user_plugin_matches_golden(db):
    data, expected = _golden("user-plugin")
    await _seed_ws_org(db, data)
    p = data["plugin"]
    plugin = UserPlugin(
        id=p["id"], entity_id=p["entityId"], workspace_id=p["workspaceId"],
        files=p["files"], organization=p["organization"],
        git_remote_config=p["gitRemoteConfig"], created_by_id=p["createdById"],
        created_by=p["createdBy"], created_by_details=p["createdByDetails"],
        readme=p.get("readme"), license=p.get("license"),
        created_at=_dt(p["createdAt"]), updated_at=_dt(p["updatedAt"]),
    )
    db.add(plugin)
    await db.commit()
    _assert_tree(await build_user_plugin_tree(db, plugin), expected)


class TestCanonicalSchemaMapping:
    """Export ordering must not depend on edit history: two instances holding the
    same mapping have to emit the same bytes, or git shows a diff where nothing
    changed. Mirrors canonicalSchemaMapping in entity-io.ts — the two must agree
    byte for byte."""

    def test_independent_of_the_order_fields_were_written_in(self):
        from app.services.workspace_export_assemble import _canonical_schema_mapping

        a = _canonical_schema_mapping(
            {"eventTables": {"T": {"table": "t", "dateColumn": "d", "conceptIdColumn": "c"}}}
        )
        b = _canonical_schema_mapping(
            {"eventTables": {"T": {"conceptIdColumn": "c", "table": "t", "dateColumn": "d"}}}
        )
        assert json.dumps(a) == json.dumps(b)

    def test_keeps_the_end_date_beside_the_date(self):
        from app.services.workspace_export_assemble import _canonical_schema_mapping

        out = _canonical_schema_mapping(
            {"eventTables": {"A": {"conceptIdColumn": "c", "endDateColumn": "e", "dateColumn": "d"}}}
        )
        keys = list(out["eventTables"]["A"])
        assert keys.index("endDateColumn") == keys.index("dateColumn") + 1

    def test_sorts_table_labels_and_appends_unknown_fields_sorted(self):
        from app.services.workspace_export_assemble import _canonical_schema_mapping

        out = _canonical_schema_mapping(
            {"eventTables": {"Zeta": {"table": "z"}, "Alpha": {"zzz": 1, "table": "a", "aaa": 2}}}
        )
        assert list(out["eventTables"]) == ["Alpha", "Zeta"]
        assert list(out["eventTables"]["Alpha"]) == ["table", "aaa", "zzz"]

    def test_still_orders_a_mapping_with_no_event_tables(self):
        from app.services.workspace_export_assemble import _canonical_schema_mapping

        m = {"presetId": "x"}
        assert _canonical_schema_mapping(m) == m

    def test_orders_the_top_level_however_it_was_assembled(self):
        """The shape reassemblePresetMapping produces: a preset's repo keeps
        presetId/presetLabel in entity.json, so re-adding them after the spread
        appended them at the end and churned an installed database's diff."""
        from app.services.workspace_export_assemble import _canonical_schema_mapping

        out = _canonical_schema_mapping(
            {
                "knownTables": ["a"],
                "eventTables": {},
                "presetId": "mimic-iv",
                "presetLabel": {"en": "MIMIC-IV"},
            }
        )
        assert list(out) == ["presetId", "presetLabel", "eventTables", "knownTables"]
