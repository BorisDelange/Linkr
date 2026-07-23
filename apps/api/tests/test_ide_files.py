"""IDE scripts/ — disk is the single source of truth (real filenames, scanned)."""

from app.config import settings
from app.services import project_fs

API = "/api/v1"


async def _admin_headers(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _project(client, headers) -> str:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    return (await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]


def _scripts(uid):
    return settings.data_path / "projects" / uid / "scripts"


async def test_create_writes_real_file_with_readable_name(client, seed_roles):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    r = await client.post(f"{API}/ide-files", headers=h, json={
        "projectUid": uid, "path": "analysis.py", "type": "file", "content": "print('hi')",
    })
    assert r.status_code == 201
    body = r.json()
    assert body["path"] == "analysis.py" and body["language"] == "python"
    disk = _scripts(uid) / "analysis.py"
    assert disk.is_file() and disk.read_text() == "print('hi')"


async def test_list_scans_disk_including_externally_added_files(client, seed_roles):
    """A file dropped in by another tool (not the API) must appear in the tree."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    # Simulate an external copy straight onto disk.
    (_scripts(uid) / "utils").mkdir(parents=True, exist_ok=True)
    (_scripts(uid) / "utils" / "helpers.R").write_text("x <- 1")

    files = (await client.get(f"{API}/ide-files", headers=h, params={"projectUid": uid})).json()
    by_path = {f["path"]: f for f in files}
    assert "utils" in by_path and by_path["utils"]["type"] == "folder"
    assert by_path["utils/helpers.R"]["content"] == "x <- 1"
    assert by_path["utils/helpers.R"]["language"] == "r"
    # Child's parentId points at the folder's derived id.
    assert by_path["utils/helpers.R"]["parentId"] == by_path["utils"]["id"]


async def test_save_content_updates_disk(client, seed_roles):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    await client.post(f"{API}/ide-files", headers=h, json={"projectUid": uid, "path": "s.py", "type": "file", "content": "v1"})
    r = await client.put(f"{API}/ide-files/content", headers=h, json={"projectUid": uid, "path": "s.py", "content": "v2"})
    assert r.status_code == 204
    assert (_scripts(uid) / "s.py").read_text() == "v2"


async def test_move_renames_on_disk(client, seed_roles):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    await client.post(f"{API}/ide-files", headers=h, json={"projectUid": uid, "path": "old.py", "type": "file", "content": "a=1"})
    r = await client.post(f"{API}/ide-files/move", headers=h, json={"projectUid": uid, "path": "old.py", "newPath": "new.py"})
    assert r.status_code == 204
    assert not (_scripts(uid) / "old.py").exists()
    assert (_scripts(uid) / "new.py").read_text() == "a=1"


async def test_delete_removes_file_and_disappears_from_scan(client, seed_roles):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    await client.post(f"{API}/ide-files", headers=h, json={"projectUid": uid, "path": "gone.py", "type": "file", "content": "x"})
    assert (_scripts(uid) / "gone.py").is_file()
    r = await client.post(f"{API}/ide-files/delete", headers=h, json={"projectUid": uid, "path": "gone.py"})
    assert r.status_code == 204
    assert not (_scripts(uid) / "gone.py").exists()
    files = (await client.get(f"{API}/ide-files", headers=h, params={"projectUid": uid})).json()
    assert all(f["path"] != "gone.py" for f in files)


async def test_no_synthetic_root_files_at_working_dir_root(client, seed_roles):
    """The tree has no synthetic 'scripts' root: the IDE working dir IS the root, so
    a fresh project is empty and a file created at the root lands directly in it,
    never under scripts/scripts/ (matching what a terminal opened there sees)."""
    h = await _admin_headers(client)
    uid = await _project(client, h)
    # Fresh project: no synthetic root, empty tree.
    files = (await client.get(f"{API}/ide-files", headers=h, params={"projectUid": uid})).json()
    assert files == []

    await client.post(f"{API}/ide-files", headers=h, json={"projectUid": uid, "path": "a.py", "type": "file", "content": "x"})
    files = (await client.get(f"{API}/ide-files", headers=h, params={"projectUid": uid})).json()
    roots = [f for f in files if f["parentId"] is None]
    assert [f["path"] for f in roots] == ["a.py"]
    assert (_scripts(uid) / "a.py").is_file()
    assert not (_scripts(uid) / "scripts").exists()


async def test_path_traversal_rejected():
    import pytest

    with pytest.raises(ValueError):
        project_fs.script_path("proj-1", "../../etc/passwd")


async def test_node_id_stable_for_path():
    a = project_fs.node_id("ide", "utils/helpers.R")
    b = project_fs.node_id("ide", "utils/helpers.R")
    c = project_fs.node_id("ide", "utils/other.R")
    assert a == b and a != c
