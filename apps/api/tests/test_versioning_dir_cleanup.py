"""Deleting a versionable entity must also remove its on-disk versioning working
tree (data_path/<kind>/<id>/versioning), or it lingers as an orphan folder."""

import pytest

from app.config import settings
from app.models.data_catalog import DataCatalog
from app.models.dq_rule_set import DqRuleSet
from app.models.etl_pipeline import EtlPipeline
from app.models.mapping_project import MappingProject
from app.models.schema_preset import SchemaPreset
from app.models.sql_script import SqlScriptCollection
from app.models.user_plugin import UserPlugin
from app.models.workspace import Workspace
from app.services import (
    data_catalog_service,
    dq_rule_set_service,
    etl_pipeline_service,
    git_service,
    mapping_project_service,
    schema_preset_service,
    sql_script_service,
    user_plugin_service,
    workspace_service,
)


def _repo_dir(kind: str, entity_id: str):
    # Mirrors git_service's *_repo helpers (which mkdir on access). Creating the
    # dir here simulates the entity having been versioned at least once.
    return git_service._entity_repo(kind, entity_id)


async def test_deleting_mapping_project_removes_its_versioning_dir(db):
    ws = Workspace(id="ws1", name={"en": "W"})
    db.add(ws)
    await db.commit()
    mp = MappingProject(id="mp1", workspace_id="ws1", name={"en": "M"}, source_type="file")
    db.add(mp)
    await db.commit()

    repo = _repo_dir("mapping-projects", "mp1")
    (repo / "project.json").write_text("{}")
    assert repo.exists()

    await mapping_project_service.delete(db, mp)

    # The whole mapping-projects/<id> dir is gone, not just its contents.
    assert not (settings.data_path / "mapping-projects" / "mp1").exists()


async def test_deleting_workspace_removes_its_and_its_mapping_projects_versioning_dirs(db):
    ws = Workspace(id="ws2", name={"en": "W"})
    db.add(ws)
    await db.commit()
    mp = MappingProject(id="mp2", workspace_id="ws2", name={"en": "M"}, source_type="file")
    db.add(mp)
    await db.commit()

    ws_repo = _repo_dir("workspaces", "ws2")
    mp_repo = _repo_dir("mapping-projects", "mp2")
    (ws_repo / "workspace.json").write_text("{}")
    (mp_repo / "project.json").write_text("{}")

    await workspace_service.delete(db, ws)

    assert not (settings.data_path / "workspaces" / "ws2").exists()
    assert not (settings.data_path / "mapping-projects" / "mp2").exists()


# Every other versionable entity, each with the folder segment its repo getter
# uses and a factory for a minimal valid row. Table-driven so adding a new
# versionable scope without wiring its delete() shows up as a failure here.
_SCOPES = [
    (
        "etl-pipelines",
        lambda wid, eid: EtlPipeline(id=eid, workspace_id=wid, name={"en": "P"}),
        etl_pipeline_service,
    ),
    (
        "sql-collections",
        lambda wid, eid: SqlScriptCollection(id=eid, workspace_id=wid, name={"en": "C"}),
        sql_script_service,
    ),
    (
        "data-catalogs",
        lambda wid, eid: DataCatalog(
            id=eid, workspace_id=wid, name={"en": "D"}, data_source_id="ds1"
        ),
        data_catalog_service,
    ),
    (
        "dq-rule-sets",
        lambda wid, eid: DqRuleSet(
            id=eid, workspace_id=wid, name={"en": "R"}, data_source_id="ds1"
        ),
        dq_rule_set_service,
    ),
    (
        "schema-presets",
        # Keyed on `id` like every other entity since revision e6f7a8b9c0d1.
        lambda wid, eid: SchemaPreset(id=eid, entity_id=eid, workspace_id=wid),
        schema_preset_service,
    ),
    (
        "user-plugins",
        lambda wid, eid: UserPlugin(id=eid, workspace_id=wid, files={}),
        user_plugin_service,
    ),
]


@pytest.mark.parametrize(
    "kind,make,service", _SCOPES, ids=[s[0] for s in _SCOPES]
)
async def test_deleting_entity_removes_its_versioning_dir(db, kind, make, service):
    ws = Workspace(id="ws-scope", name={"en": "W"})
    db.add(ws)
    await db.commit()
    entity = make("ws-scope", "ent1")
    db.add(entity)
    await db.commit()

    repo = _repo_dir(kind, "ent1")
    (repo / "entity.json").write_text("{}")

    await service.delete(db, entity)

    assert not (settings.data_path / kind / "ent1").exists()


async def test_remove_repo_is_a_noop_when_absent():
    # Never-versioned entity: no dir on disk → delete must not raise.
    git_service.remove_repo("mapping-projects", "never-versioned-id")
