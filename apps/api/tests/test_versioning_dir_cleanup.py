"""Deleting a versionable entity must also remove its on-disk versioning working
tree (data_path/<kind>/<id>/versioning), or it lingers as an orphan folder."""

from app.config import settings
from app.models.mapping_project import MappingProject
from app.models.workspace import Workspace
from app.services import git_service, mapping_project_service, workspace_service


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


async def test_remove_repo_is_a_noop_when_absent():
    # Never-versioned entity: no dir on disk → delete must not raise.
    git_service.remove_repo("mapping-projects", "never-versioned-id")
