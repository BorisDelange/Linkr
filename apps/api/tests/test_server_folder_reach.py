"""What the server file routes reach: another workspace's database folder stays that
workspace's, and with no browse roots the whole filesystem answers to code
execution rights, as a script would."""

import os

from app.config import settings
from app.core.security import hash_password
from app.models.project import Project
from app.models.role import Role
from app.models.user import User
from app.models.workspace_member import WorkspaceMember
from tests.test_ide_files import _admin_headers

API = "/api/v1"

_DB_WRITER = ["databases:read", "databases:write", "concept-mapping:read", "concept-mapping:write"]
_IMPORTER = ["datasets:read", "datasets:write", "project-settings:read", "project-settings:write", "ide:read"]


async def _workspace(client, h) -> str:
    return (await client.post(f"{API}/workspaces", headers=h, json={"name": {"en": "WS"}})).json()["id"]


async def _project_in(client, h, ws: str) -> str:
    return (await client.post(f"{API}/projects", headers=h, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]


async def _member(client, db, ws: str, username: str, permissions: list[str]) -> dict:
    db.add(Role(name=f"{username}-role", label={}, scope="workspace", permissions=permissions))
    user = User(username=username, password_hash=hash_password("pw-for-tests-only"), role="user")
    db.add(user)
    await db.flush()
    db.add(WorkspaceMember(workspace_id=ws, user_id=user.id, role=f"{username}-role"))
    await db.commit()
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _source(ws: str, path, alias: str = "db") -> dict:
    return {
        "workspaceId": ws, "alias": alias, "name": {"en": "DB"}, "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "serverPath": str(path)},
    }


async def test_another_workspaces_database_folder_is_refused_to_file_routes(
    client, seed_roles, db, tmp_path_factory, monkeypatch,
):
    root = tmp_path_factory.mktemp("roots")
    monkeypatch.setattr(settings, "fs_browse_roots", str(root))
    mart, own = root / "w1mart", root / "w2own"
    mart.mkdir()
    own.mkdir()
    (mart / "person.csv").write_text("id\nDUMMY-W1-ROW\n")
    (own / "person.csv").write_text("id\nREPLACED\n")
    h = await _admin_headers(client)
    w1, w2 = await _workspace(client, h), await _workspace(client, h)
    assert (await client.post(f"{API}/data-sources", headers=h, json=_source(w1, mart))).status_code == 201
    p2 = await _project_in(client, h, w2)
    w2_member = await _member(client, db, w2, "w2", _DB_WRITER + _IMPORTER)
    w1_member = await _member(client, db, w1, "w1", _DB_WRITER)

    listing = f"{API}/workspaces/{w2}/fs/list-dir"
    assert (await client.get(listing, headers=w2_member, params={"path": str(mart), "includeFiles": "true"})).status_code == 403
    above = (await client.get(listing, headers=w2_member, params={"path": str(root)})).json()
    assert [e["name"] for e in above["entries"]] == ["w2own"]
    r = await client.post(f"{API}/mapping-projects/import-server-file", headers=w2_member, json={
        "workspaceId": w2, "path": str(mart / "person.csv"),
    })
    assert r.status_code == 403
    r = await client.post(f"{API}/dataset-files/stage-server-file", headers=w2_member, json={
        "projectUid": p2, "serverPath": str(mart / "person.csv"),
    })
    assert r.status_code == 403
    assert (await client.post(f"{API}/data-sources", headers=w2_member, json=_source(w2, mart))).status_code == 403
    r = await client.post(f"{API}/projects/{p2}/fs/rebind-copy", headers=w2_member, json={
        "src": str(own), "dst": str(mart), "on_conflict": "overwrite",
    })
    assert r.status_code == 403
    assert (mart / "person.csv").read_text() == "id\nDUMMY-W1-ROW\n"

    w1_listing = f"{API}/workspaces/{w1}/fs/list-dir"
    assert (await client.get(w1_listing, headers=w1_member, params={"path": str(mart)})).status_code == 200
    assert (await client.get(listing, headers=h, params={"path": str(mart)})).status_code == 200


async def test_a_database_kept_on_a_path_another_workspace_registered_stays_editable(
    client, seed_roles, db, tmp_path_factory, monkeypatch,
):
    root = tmp_path_factory.mktemp("roots")
    monkeypatch.setattr(settings, "fs_browse_roots", str(root))
    mart = root / "shared"
    mart.mkdir()
    h = await _admin_headers(client)
    w1, w2 = await _workspace(client, h), await _workspace(client, h)
    assert (await client.post(f"{API}/data-sources", headers=h, json=_source(w1, mart))).status_code == 201
    created = await client.post(f"{API}/data-sources", headers=h, json=_source(w2, mart, "db2"))
    assert created.status_code == 201
    w2_member = await _member(client, db, w2, "w2", _DB_WRITER)
    r = await client.patch(f"{API}/data-sources/{created.json()['id']}", headers=w2_member, json={
        "name": {"en": "Renamed"}, "connectionConfig": {"engine": "duckdb", "serverPath": str(mart)},
    })
    assert r.status_code == 200, r.text


async def test_without_browse_roots_project_folder_routes_need_code_execution(
    client, seed_roles, db, tmp_path_factory, monkeypatch,
):
    monkeypatch.setattr(settings, "fs_browse_roots", "")
    src, dst = tmp_path_factory.mktemp("outside"), tmp_path_factory.mktemp("victim")
    (src / "f.txt").write_text("REPLACED")
    (dst / "f.txt").write_text("ORIGINAL")
    h = await _admin_headers(client)
    ws = await _workspace(client, h)
    uid = await _project_in(client, h, ws)
    no_exec = await _member(client, db, ws, "settings", _IMPORTER)
    base = f"{API}/projects/{uid}/fs"

    r = await client.post(f"{base}/rebind-copy", headers=no_exec, json={"src": str(src), "dst": str(dst), "on_conflict": "overwrite"})
    assert r.status_code == 403
    assert (dst / "f.txt").read_text() == "ORIGINAL"
    assert (await client.get(f"{base}/list-dir", headers=no_exec, params={"path": str(src)})).status_code == 403
    assert (await client.post(f"{base}/validate", headers=no_exec, json={"path": str(src)})).status_code == 403

    runner = await _member(client, db, ws, "runner", _IMPORTER + ["ide:execute"])
    assert (await client.get(f"{base}/list-dir", headers=runner, params={"path": str(src)})).status_code == 200
    r = await client.post(f"{base}/rebind-copy", headers=runner, json={"src": str(src), "dst": str(dst), "on_conflict": "overwrite"})
    assert r.status_code == 200
    assert (dst / "f.txt").read_text() == "REPLACED"


async def test_the_project_folder_picker_never_lists_linkrs_data_folder_nor_another_projects_folder(
    client, seed_roles, db, tmp_path_factory, monkeypatch,
):
    monkeypatch.setattr(settings, "fs_browse_roots", "")
    h = await _admin_headers(client)
    ws = await _workspace(client, h)
    uid = await _project_in(client, h, ws)
    other = await _project_in(client, h, await _workspace(client, h))
    parent = tmp_path_factory.mktemp("srv")
    theirs = parent / "theirs"
    theirs.mkdir()
    (await db.get(Project, other)).ide_path = str(theirs)
    await db.commit()
    runner = await _member(client, db, ws, "runner", _IMPORTER + ["ide:execute"])
    url = f"{API}/projects/{uid}/fs/list-dir"

    settings.data_path.mkdir(parents=True, exist_ok=True)
    assert (await client.get(url, headers=runner, params={"path": str(settings.data_path)})).status_code == 403
    above = (await client.get(url, headers=runner, params={"path": str(settings.data_path.parent)})).json()
    assert settings.data_path.name not in [e["name"] for e in above["entries"]]
    assert (await client.get(url, headers=runner, params={"path": str(theirs)})).status_code == 403
    assert "theirs" not in [e["name"] for e in (await client.get(url, headers=runner, params={"path": str(parent)})).json()["entries"]]

    own_default = (await client.get(f"{API}/projects/{uid}/fs/resolved", headers=runner)).json()["defaults"]["ide"]
    os.makedirs(own_default, exist_ok=True)
    assert (await client.get(url, headers=runner, params={"path": own_default})).status_code == 200


async def test_a_copy_skips_a_link_leading_outside_the_browse_roots(
    client, seed_roles, db, tmp_path_factory, monkeypatch,
):
    root, outside = tmp_path_factory.mktemp("roots"), tmp_path_factory.mktemp("outside")
    (outside / "secret.txt").write_text("OUTSIDE-ROOT")
    src, dst = root / "src", root / "dst"
    src.mkdir()
    dst.mkdir()
    (src / "kept.txt").write_text("in")
    (src / "link.txt").symlink_to(outside / "secret.txt")
    monkeypatch.setattr(settings, "fs_browse_roots", str(root))
    h = await _admin_headers(client)
    uid = await _project_in(client, h, await _workspace(client, h))
    r = await client.post(f"{API}/projects/{uid}/fs/rebind-copy", headers=h, json={"src": str(src), "dst": str(dst)})
    assert r.status_code == 200
    assert (dst / "kept.txt").exists()
    assert not (dst / "link.txt").exists()


async def test_without_browse_roots_a_mapping_import_from_the_server_needs_code_execution(
    client, seed_roles, db, tmp_path_factory, monkeypatch,
):
    monkeypatch.setattr(settings, "fs_browse_roots", "")
    outside = tmp_path_factory.mktemp("outside")
    (outside / "dummy.csv").write_text("code\nDUMMY-CSV-ROW\n")
    h = await _admin_headers(client)
    ws = await _workspace(client, h)
    no_exec = await _member(client, db, ws, "mapper", _DB_WRITER)
    body = {"workspaceId": ws, "path": str(outside / "dummy.csv")}
    url = f"{API}/mapping-projects/import-server-file"
    assert (await client.post(url, headers=no_exec, json=body)).status_code == 403

    runner = await _member(client, db, ws, "runner", _DB_WRITER + ["ide:execute"])
    assert (await client.post(url, headers=runner, json=body)).status_code == 200

    monkeypatch.setattr(settings, "fs_browse_roots", str(outside))
    assert (await client.post(url, headers=no_exec, json=body)).status_code == 200


async def test_without_browse_roots_a_vocabulary_import_from_the_server_needs_code_execution(
    client, seed_roles, db, tmp_path_factory, monkeypatch,
):
    monkeypatch.setattr(settings, "fs_browse_roots", "")
    outside = tmp_path_factory.mktemp("outside")
    (outside / "CONCEPT.csv").write_text("concept_id\tvocabulary_id\n1\tPRIVATEVOC\n")
    h = await _admin_headers(client)
    ws = await _workspace(client, h)
    no_exec = await _member(client, db, ws, "librarian", ["workspace-settings:read", "workspace-settings:write"])
    r = await client.post(f"{API}/workspaces/{ws}/vocabulary-library/inspect", headers=no_exec, json={
        "serverPaths": [str(outside / "CONCEPT.csv")],
    })
    assert r.status_code == 403
    assert "PRIVATEVOC" not in r.text
