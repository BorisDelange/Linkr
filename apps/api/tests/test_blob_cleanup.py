"""Project/workspace deletion must clean up disk: the project's working
directory always, and blobs only when no row anywhere still references them
(content-addressed blobs can be shared across projects/workspaces)."""

import uuid

import pytest

from app.config import settings
from app.models.attachment import ReadmeAttachment
from app.models.dataset import DatasetFile
from app.models.mapping_project import MappingProject
from app.models.project import Project
from app.models.workspace import Workspace
from app.services import blob_cleanup, blob_store, project_fs, project_service, workspace_service


def _uid() -> str:
    return str(uuid.uuid4())


def _project_dir_path(project_uid: str):
    """Same path project_fs.project_dir() resolves to, WITHOUT its side effect
    of recreating the directory (which would make an `.exists()` check useless
    after deletion)."""
    return settings.data_path / "projects" / project_uid


async def _make_workspace(db) -> str:
    ws = Workspace(id=_uid(), name={"en": "WS"}, description={})
    db.add(ws)
    await db.commit()
    return ws.id


async def _make_project(db, workspace_id: str) -> Project:
    project = Project(
        uid=_uid(), workspace_id=workspace_id, name={"en": "P"}, description={},
        short_description={}, config={},
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return project


async def _store_blob(data: bytes) -> str:
    sha, _ = await blob_store.store_bytes(data)
    return sha


async def test_project_delete_removes_working_directory(db):
    ws_id = await _make_workspace(db)
    project = await _make_project(db, ws_id)

    scripts_dir = project_fs.scripts_dir(project.uid)
    (scripts_dir / "analysis.py").write_text("print(1)")
    assert project_fs.project_dir(project.uid).is_dir()

    await project_service.delete(db, project)

    assert not _project_dir_path(project.uid).exists()


async def test_project_delete_removes_unreferenced_blob(db):
    ws_id = await _make_workspace(db)
    project = await _make_project(db, ws_id)
    sha = await _store_blob(b"raw dataset bytes")

    db.add(DatasetFile(
        id=_uid(), project_uid=project.uid, name="d.csv", type="file",
        raw_sha=sha,
    ))
    await db.commit()
    assert blob_store.exists(sha)

    await project_service.delete(db, project)

    assert not blob_store.exists(sha)


async def test_project_delete_keeps_blob_still_referenced_elsewhere(db):
    """A blob shared by two projects (dedup) must survive deleting only one."""
    ws_id = await _make_workspace(db)
    project_a = await _make_project(db, ws_id)
    project_b = await _make_project(db, ws_id)
    sha = await _store_blob(b"shared parquet bytes")

    db.add(DatasetFile(
        id=_uid(), project_uid=project_a.uid, name="d.csv", type="file", raw_sha=sha,
    ))
    db.add(DatasetFile(
        id=_uid(), project_uid=project_b.uid, name="d.csv", type="file", raw_sha=sha,
    ))
    await db.commit()

    await project_service.delete(db, project_a)

    assert blob_store.exists(sha), "blob still referenced by project_b must survive"


async def test_workspace_delete_removes_project_dirs_and_dereferences_blobs(db):
    ws_id = await _make_workspace(db)
    project = await _make_project(db, ws_id)
    project_fs.scripts_dir(project.uid)  # materialize the dir
    sha = await _store_blob(b"mapping source csv")

    db.add(MappingProject(
        id=_uid(), workspace_id=ws_id, name={"en": "M"}, source_type="file",
        raw_file_sha=sha,
    ))
    await db.commit()

    ws = await db.get(Workspace, ws_id)
    await workspace_service.delete(db, ws)

    assert not _project_dir_path(project.uid).exists()
    assert not blob_store.exists(sha)


async def test_workspace_delete_keeps_blob_shared_with_another_workspace(db):
    ws_a = await _make_workspace(db)
    ws_b = await _make_workspace(db)
    sha = await _store_blob(b"shared ohdsi vocabulary")

    db.add(MappingProject(
        id=_uid(), workspace_id=ws_a, name={"en": "M"}, source_type="file",
        raw_file_sha=sha,
    ))
    db.add(MappingProject(
        id=_uid(), workspace_id=ws_b, name={"en": "M"}, source_type="file",
        raw_file_sha=sha,
    ))
    await db.commit()

    ws = await db.get(Workspace, ws_a)
    await workspace_service.delete(db, ws)

    assert blob_store.exists(sha), "blob still referenced by ws_b must survive"


async def test_deref_blobs_ignores_empty_and_missing_shas(db):
    # Empty sha is skipped outright (never a real blob). A well-formed but
    # already-absent sha is unreferenced, so it's "deleted" (no-op unlink) —
    # must not raise.
    deleted = await blob_cleanup.deref_blobs(db, {"", "a" * 64})
    assert deleted == 1


async def test_readme_attachment_blob_dereferenced_on_project_delete(db):
    ws_id = await _make_workspace(db)
    project = await _make_project(db, ws_id)
    sha = await _store_blob(b"attachment image bytes")

    db.add(ReadmeAttachment(
        id=_uid(), project_uid=project.uid, file_name="a.png", blob_sha=sha,
    ))
    await db.commit()

    await project_service.delete(db, project)

    assert not blob_store.exists(sha)


pytestmark = pytest.mark.asyncio
