"""An entity id that names a folder stays a single safe path segment, so deleting
the entity only ever removes that entity's own folder."""

import pytest
from pydantic import ValidationError

from app.config import settings
from app.core import path_ids
from app.models.project import Project
from app.models.workspace import Workspace
from app.schemas.data_catalog import DataCatalogCreate
from app.schemas.data_source import DataSourceCreate
from app.schemas.dq_rule_set import DqRuleSetCreate
from app.schemas.etl_pipeline import EtlPipelineCreate
from app.schemas.mapping_project import MappingProjectCreate
from app.schemas.project import ProjectCreate
from app.schemas.schema_preset import SchemaPresetSave
from app.schemas.sql_script import SqlScriptCollectionCreate
from app.schemas.user_plugin import UserPluginCreate
from app.schemas.workspace import WorkspaceCreate
from app.services import (
    git_service,
    project_fs,
    project_service,
    vocabulary_library,
    workspace_service,
)

API = "/api/v1"
UNSAFE = [".", "..", "", "a/b", "../x", "../../x", "a\\b", ".hidden", "/abs", "x" * 200]
SAFE = ["2b0c7f9e-1d3a-4c5b-9e8f-0a1b2c3d4e5f", "omop-cdm-5.4", "demo_workspace", "P1"]


@pytest.mark.parametrize("value", UNSAFE)
def test_an_unsafe_id_is_not_a_path_segment(value, tmp_path):
    assert not path_ids.is_safe_segment(value)
    with pytest.raises(path_ids.UnsafePathSegment):
        path_ids.child_dir(tmp_path, value)


@pytest.mark.parametrize("value", SAFE)
def test_a_uuid_or_slug_names_a_direct_child(value, tmp_path):
    assert path_ids.child_dir(tmp_path, value) == tmp_path / value


@pytest.mark.parametrize("value", [".", "..", "a/b", "../x"])
def test_ids_that_name_folders_are_checked_where_they_are_accepted(value):
    with pytest.raises(ValidationError):
        ProjectCreate(uid=value, workspace_id="w", name={"en": "p"})
    with pytest.raises(ValidationError):
        WorkspaceCreate(id=value, name={"en": "w"})
    with pytest.raises(ValidationError):
        SchemaPresetSave(preset_id=value)
    with pytest.raises(ValidationError):
        SchemaPresetSave(preset_id="ok", id=value)
    with pytest.raises(ValidationError):
        DataSourceCreate(id=value, name="d", source_type="database")
    for model in (
        MappingProjectCreate,
        SqlScriptCollectionCreate,
        EtlPipelineCreate,
        DataCatalogCreate,
        DqRuleSetCreate,
        UserPluginCreate,
    ):
        with pytest.raises(ValidationError) as err:
            model.model_validate({"id": value, "workspaceId": "w", "name": {"en": "x"}})
        assert any(e["loc"] == ("id",) for e in err.value.errors()), model


def test_project_dir_stays_under_the_projects_root():
    for value in ("..", ".", "../x"):
        with pytest.raises(path_ids.UnsafePathSegment):
            project_fs.project_dir(value)


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def test_creating_a_project_whose_uid_is_not_a_segment_is_refused(client):
    headers = await _admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "W"}})).json()["id"]
    for uid in ("..", ".", "a/b", "../x"):
        r = await client.post(
            f"{API}/projects", headers=headers, json={"uid": uid, "workspaceId": ws, "name": {"en": "p"}}
        )
        assert r.status_code == 422, uid
    r = await client.post(f"{API}/workspaces", headers=headers, json={"id": ".", "name": {"en": "W"}})
    assert r.status_code == 422


def _sentinel():
    settings.data_path.mkdir(parents=True, exist_ok=True)
    s = settings.data_path / "sentinel.txt"
    s.write_text("keep")
    return s


async def test_deleting_a_stored_project_with_an_unsafe_uid_removes_no_folder(db):
    db.add(Workspace(id="ws-a", name={"en": "W"}))
    await db.commit()
    other = project_fs.project_dir("other-project") / "scripts"
    other.mkdir(parents=True)
    (other / "keep.py").write_text("x = 1")
    sentinel = _sentinel()
    row = Project(uid="..", workspace_id="ws-a", name={"en": "p"})
    db.add(row)
    await db.commit()

    await project_service.delete(db, row)

    assert sentinel.exists()
    assert (other / "keep.py").exists()


async def test_deleting_a_stored_workspace_with_an_unsafe_id_keeps_other_workspaces_folders(db):
    victim_repo = git_service._entity_repo("workspaces", "victim")
    (victim_repo / "workspace.json").write_text("{}")
    victim_vocab = vocabulary_library.library_dir("victim")
    victim_vocab.mkdir(parents=True)
    (victim_vocab / "concept.parquet").write_bytes(b"x")
    row = Workspace(id=".", name={"en": "W"})
    db.add(row)
    await db.commit()

    await workspace_service.delete(db, row)

    assert (victim_repo / "workspace.json").exists()
    assert (victim_vocab / "concept.parquet").exists()


def test_removing_a_versioning_tree_only_ever_removes_that_entity_s_folder():
    victim = git_service._entity_repo("mapping-projects", "victim-mp")
    (victim / "project.json").write_text("{}")
    for value in (".", "..", "a/..", ""):
        git_service.remove_repo("mapping-projects", value)
    assert (victim / "project.json").exists()
    assert settings.data_path.exists()

    git_service.remove_repo("mapping-projects", "victim-mp")
    assert not (settings.data_path / "mapping-projects" / "victim-mp").exists()
