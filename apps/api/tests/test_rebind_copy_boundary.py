"""A server-side copy never reads or writes a place a binding of the same user
would be refused: system folders, Linkr's data folder, other projects' folders."""

import os

import pytest
from sqlalchemy import select

from app.config import settings
from app.models.project import Project
from app.models.user import User
from app.models.workspace_member import WorkspaceMember
from app.services import fs_browser
from tests.test_ide_files import _admin_headers, _project, _user_with_global_role

API = "/api/v1"


def _no_grant() -> fs_browser.FolderScope:
    return fs_browser.FolderScope(whole_fs_allowed=False)


def _folder(parent, name: str) -> str:
    d = parent / name
    d.mkdir(parents=True, exist_ok=True)
    return str(d)


async def _copy(client, headers, uid: str, src, dst, on_conflict: str = "overwrite"):
    return await client.post(f"{API}/projects/{uid}/fs/rebind-copy", headers=headers, json={
        "src": str(src), "dst": str(dst), "on_conflict": on_conflict,
    })


async def test_rebind_copy_moves_files_between_two_bindable_folders(client, seed_roles, tmp_path_factory):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    server = tmp_path_factory.mktemp("server")
    src, dst = _folder(server, "old"), _folder(server, "new")
    (server / "old" / "a.txt").write_text("kept")

    r = await _copy(client, h, uid, src, dst)
    assert r.status_code == 200, r.text
    assert r.json()["copied"] == 1
    assert (server / "new" / "a.txt").read_text() == "kept"


async def test_rebind_copy_never_reads_a_system_folder(client, seed_roles, tmp_path_factory, monkeypatch):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    dst = _folder(tmp_path_factory.mktemp("server"), "new")
    fake_system = tmp_path_factory.mktemp("system")
    (fake_system / "environ").write_text("DUMMY_SECRET=1")
    monkeypatch.setattr(fs_browser, "_SYSTEM_DIRS", (fake_system,))

    r = await _copy(client, h, uid, fake_system, dst)
    assert r.status_code == 403
    assert os.listdir(dst) == []


async def test_rebind_copy_never_reads_linkrs_data_folder(client, seed_roles, tmp_path_factory):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    settings.data_path.mkdir(parents=True, exist_ok=True)
    (settings.data_path / "secret.key").write_text("dummy-key")
    (settings.data_path / "projects").mkdir(exist_ok=True)
    dst = _folder(tmp_path_factory.mktemp("server"), "new")

    for src in (settings.data_path, settings.data_path / "projects"):
        r = await _copy(client, h, uid, src, dst)
        assert r.status_code == 403, str(src)
    assert os.listdir(dst) == []


async def test_rebind_copy_never_writes_into_linkrs_data_folder(client, seed_roles, tmp_path_factory):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    settings.data_path.mkdir(parents=True, exist_ok=True)
    server = tmp_path_factory.mktemp("server")
    src = _folder(server, "old")
    (server / "old" / "linkr-marker.db").write_text("dummy")

    r = await _copy(client, h, uid, src, settings.data_path)
    assert r.status_code == 403
    assert not (settings.data_path / "linkr-marker.db").exists()


async def test_rebind_copy_keeps_off_another_projects_folder(client, seed_roles, db, tmp_path_factory):
    admin = await _admin_headers(client)
    uid = await _project(client, admin)
    other = await _project(client, admin)
    server = tmp_path_factory.mktemp("server")
    theirs, mine = _folder(server, "theirs"), _folder(server, "mine")
    (server / "theirs" / "a.txt").write_text("theirs")
    (await db.get(Project, other)).scripts_path = theirs
    await db.commit()

    bob = await _user_with_global_role(client, db, admin, "bob", [])
    bob_id = (await db.execute(select(User.id).where(User.username == "bob"))).scalar_one()
    workspace_id = (await db.get(Project, uid)).workspace_id
    db.add(WorkspaceMember(workspace_id=workspace_id, user_id=bob_id, role="editor"))
    await db.commit()

    assert (await _copy(client, bob, uid, theirs, mine)).status_code == 403
    assert (await _copy(client, bob, uid, mine, theirs)).status_code == 403
    assert os.listdir(mine) == []


def test_copy_tree_skips_a_link_leading_into_linkrs_data_folder(tmp_path_factory):
    settings.data_path.mkdir(parents=True, exist_ok=True)
    (settings.data_path / "secret.key").write_text("dummy-key")
    server = tmp_path_factory.mktemp("server")
    src, dst = server / "old", server / "new"
    src.mkdir()
    dst.mkdir()
    (src / "plain.txt").write_text("kept")
    (src / "leak.txt").symlink_to(settings.data_path / "secret.key")

    res = fs_browser.copy_tree(str(src), str(dst), "overwrite", _no_grant())
    assert (dst / "plain.txt").read_text() == "kept"
    assert not (dst / "leak.txt").exists()
    assert res["skipped"] == 1


def test_copy_tree_never_writes_through_a_link_in_the_destination(tmp_path_factory):
    settings.data_path.mkdir(parents=True, exist_ok=True)
    victim = settings.data_path / "linkr.db"
    victim.write_text("original")
    server = tmp_path_factory.mktemp("server")
    src, dst = server / "old", server / "new"
    (src / "sub").mkdir(parents=True)
    dst.mkdir()
    (src / "linkr.db").write_text("planted")
    (src / "sub" / "x.txt").write_text("planted")
    (dst / "linkr.db").symlink_to(victim)
    (dst / "sub").symlink_to(settings.data_path, target_is_directory=True)

    fs_browser.copy_tree(str(src), str(dst), "overwrite", _no_grant())
    assert victim.read_text() == "original"
    assert not (settings.data_path / "x.txt").exists()


def test_copy_tree_refuses_a_refused_root_for_any_caller(tmp_path_factory):
    settings.data_path.mkdir(parents=True, exist_ok=True)
    dst = _folder(tmp_path_factory.mktemp("server"), "new")
    with pytest.raises(fs_browser.FsImportForbidden):
        fs_browser.copy_tree(str(settings.data_path), dst, "ignore", _no_grant())
