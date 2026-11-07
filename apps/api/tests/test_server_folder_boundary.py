"""Route-level regressions for what a database's `serverPath`, a project's folder
binding and a server-file import may point at: never Linkr's data folder, and
another project's bound folder only with `project-folders:read`."""

import sqlite3
from pathlib import Path

from app.config import settings
from app.models.project import Project
from app.models.role import Role
from app.models.user import User
from app.models.workspace_member import WorkspaceMember
from tests.test_ide_files import _admin_headers, _project, _user_with_global_role

API = "/api/v1"


async def _workspace(client, headers) -> str:
    return (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]


def _sqlite_with_users(path) -> None:
    con = sqlite3.connect(path)
    con.execute("create table users(username text, password_hash text)")
    con.execute("insert into users values ('admin', '$2b$secret')")
    con.commit()
    con.close()


def _source_body(ws: str, path) -> dict:
    return {
        "workspaceId": ws, "alias": "db", "name": {"en": "DB"}, "sourceType": "database",
        "connectionConfig": {"engine": "sqlite", "serverPath": str(path)},
    }


async def test_a_workspace_viewer_reads_only_the_sqlite_database_it_was_given(client, seed_roles, tmp_path_factory):
    folder = tmp_path_factory.mktemp("server")
    own = folder / "own.db"
    _sqlite_with_users(own)
    other = folder / "other.db"
    _sqlite_with_users(other)
    settings.data_path.mkdir(parents=True, exist_ok=True)
    h = await _admin_headers(client)
    ws = await _workspace(client, h)
    source = (await client.post(f"{API}/data-sources", headers=h, json=_source_body(ws, own))).json()["id"]
    viewer = (await client.post(
        f"{API}/users", headers=h, json={"username": "reader", "password": "pw-for-tests-only-b"}
    )).json()["id"]
    assert (await client.put(
        f"{API}/workspaces/{ws}/members", headers=h, json={"userId": viewer, "role": "viewer"}
    )).status_code == 200
    token = (await client.post(
        f"{API}/auth/login", json={"username": "reader", "password": "pw-for-tests-only-b"}
    )).json()["access_token"]
    reader = {"Authorization": f"Bearer {token}"}

    query = f"{API}/data-sources/{source}/query"
    assert (await client.post(query, headers=reader, json={"sql": "SELECT username FROM users"})).status_code == 200
    for path in (other, settings.data_path / "linkr.db"):
        refused = await client.post(
            query, headers=reader, json={"sql": f"SELECT * FROM sqlite_scan('{path}', 'users')"}
        )
        assert refused.status_code == 400
        assert "secret" not in refused.text


async def test_the_database_folder_picker_leaves_linkrs_data_folder_out(client, seed_roles):
    settings.data_path.mkdir(parents=True, exist_ok=True)
    h = await _admin_headers(client)
    ws = await _workspace(client, h)
    listing = f"{API}/workspaces/{ws}/fs/list-dir"

    assert (await client.get(listing, headers=h, params={"path": str(settings.data_path)})).status_code == 403
    above = await client.get(listing, headers=h, params={"path": str(settings.data_path.parent)})
    assert above.status_code == 200
    assert str(settings.data_path.resolve()) not in [str(Path(e["path"]).resolve()) for e in above.json()["entries"]]


async def test_a_database_cannot_point_inside_linkrs_data_folder(client, seed_roles, tmp_path_factory):
    settings.data_path.mkdir(parents=True, exist_ok=True)
    victim = settings.data_path / "linkr-copy.db"
    _sqlite_with_users(victim)
    h = await _admin_headers(client)
    ws = await _workspace(client, h)

    created = await client.post(f"{API}/data-sources", headers=h, json=_source_body(ws, victim))
    assert created.status_code == 403

    elsewhere = tmp_path_factory.mktemp("server") / "ok.db"
    _sqlite_with_users(elsewhere)
    created = await client.post(f"{API}/data-sources", headers=h, json=_source_body(ws, elsewhere))
    assert created.status_code == 201
    moved = await client.patch(f"{API}/data-sources/{created.json()['id']}", headers=h, json={
        "connectionConfig": {"engine": "sqlite", "serverPath": str(victim)},
    })
    assert moved.status_code == 403


async def test_a_database_cannot_point_into_another_projects_folder_without_the_grant(
    client, seed_roles, db, tmp_path_factory,
):
    h = await _admin_headers(client)
    ws = await _workspace(client, h)
    other = await _project(client, h)
    theirs = tmp_path_factory.mktemp("theirs")
    _sqlite_with_users(theirs / "private.db")
    (await db.get(Project, other)).ide_path = str(theirs)
    await db.commit()

    member = await _user_with_global_role(client, db, h, "bob", ["all-workspaces:write", "all-projects:write"])
    r = await client.post(f"{API}/data-sources", headers=member, json=_source_body(ws, theirs / "private.db"))
    assert r.status_code == 403
    neutral = tmp_path_factory.mktemp("neutral") / "shared.db"
    _sqlite_with_users(neutral)
    r = await client.post(f"{API}/data-sources", headers=member, json=_source_body(ws, neutral))
    assert r.status_code == 201
    r = await client.post(f"{API}/data-sources", headers=h, json={**_source_body(ws, theirs / "private.db"), "alias": "db2"})
    assert r.status_code == 201


async def test_a_binding_cannot_reach_linkrs_data_folder_or_another_projects_folder(
    client, seed_roles, db, tmp_path_factory,
):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    other = await _project(client, h)
    theirs = tmp_path_factory.mktemp("theirs")
    (theirs / "inner").mkdir()
    (await db.get(Project, other)).datasets_path = str(theirs)
    await db.commit()

    def bind(headers, key, path):
        return client.patch(f"{API}/projects/{uid}/folder-bindings", headers=headers, json={key: str(path)})

    settings.data_path.mkdir(parents=True, exist_ok=True)
    for key in ("idePath", "scriptsPath", "datasetsPath"):
        assert (await bind(h, key, settings.data_path)).status_code == 403
        assert (await bind(h, key, settings.data_path.parent)).status_code == 403

    member = await _user_with_global_role(client, db, h, "bob", ["all-projects:write"])
    for path in (theirs, theirs / "inner", theirs.parent):
        assert (await bind(member, "idePath", path)).status_code == 403
    mine = tmp_path_factory.mktemp("mine")
    assert (await bind(member, "idePath", mine)).status_code == 200
    assert (await bind(h, "datasetsPath", theirs)).status_code == 200


async def test_staging_and_listing_follow_other_projects_folders(client, seed_roles, db, tmp_path_factory, monkeypatch):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    other = await _project(client, h)
    parent = tmp_path_factory.mktemp("srv")
    theirs = parent / "theirs"
    theirs.mkdir()
    (theirs / "data.csv").write_text("a\n1\n")
    (await db.get(Project, other)).datasets_path = str(theirs)
    await db.commit()
    monkeypatch.setattr(settings, "fs_browse_roots", str(parent))

    def stage(headers):
        return client.post(f"{API}/dataset-files/stage-server-file", headers=headers, json={
            "projectUid": uid, "serverPath": str(theirs / "data.csv"),
        })

    def listed(headers):
        return client.get(f"{API}/projects/{uid}/fs/import/datasets/list-dir", headers=headers, params={"path": str(parent)})

    member = await _user_with_global_role(client, db, h, "bob", ["all-projects:write"])
    assert (await stage(member)).status_code == 403
    assert "theirs" not in [e["name"] for e in (await listed(member)).json()["entries"]]

    granted = await _user_with_global_role(client, db, h, "carol", ["all-projects:write", "project-folders:read"])
    assert (await stage(granted)).status_code == 200
    assert "theirs" in [e["name"] for e in (await listed(granted)).json()["entries"]]


async def test_a_vocabulary_import_cannot_read_linkrs_data_folder(client, seed_roles):
    h = await _admin_headers(client)
    ws = await _workspace(client, h)
    settings.data_path.mkdir(parents=True, exist_ok=True)
    r = await client.post(f"{API}/workspaces/{ws}/vocabulary-library/inspect", headers=h, json={
        "serverPaths": [str(settings.data_path)],
    })
    assert r.status_code == 403


async def test_a_generic_project_update_never_sets_a_folder_binding(client, seed_roles, db, tmp_path_factory):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    bound = tmp_path_factory.mktemp("bound")
    updated = await client.patch(f"{API}/projects/{uid}", headers=h, json={
        "description": {"en": "edited"},
        "idePath": str(bound), "scriptsPath": str(bound), "datasetsPath": str(bound),
    })
    assert updated.status_code == 200
    assert updated.json()["description"] == {"en": "edited"}
    assert updated.json()["idePath"] is None
    assert updated.json()["scriptsPath"] is None
    assert updated.json()["datasetsPath"] is None


async def test_the_folder_binding_route_sets_and_clears_a_binding(client, seed_roles, tmp_path_factory):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    bound = tmp_path_factory.mktemp("bound")
    url = f"{API}/projects/{uid}/folder-bindings"
    assert (await client.patch(url, headers=h, json={"idePath": str(bound)})).json()["idePath"] == str(bound)
    other = await client.patch(url, headers=h, json={"datasetsPath": str(bound)})
    assert other.json()["idePath"] == str(bound)
    assert other.json()["datasetsPath"] == str(bound)
    assert (await client.patch(url, headers=h, json={"idePath": None})).json()["idePath"] is None


async def _member_with_role(client, db, admin, uid: str, username: str, permissions: list[str]) -> dict:
    from app.core.security import hash_password

    db.add(Role(name=f"{username}-role", label={}, scope="workspace", permissions=permissions))
    user = User(username=username, password_hash=hash_password("pw-for-tests-only"), role="user")
    db.add(user)
    await db.flush()
    project = await db.get(Project, uid)
    db.add(WorkspaceMember(workspace_id=project.workspace_id, user_id=user.id, role=f"{username}-role"))
    await db.commit()
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def test_binding_a_folder_with_no_browse_roots_needs_code_execution_rights(
    client, seed_roles, db, tmp_path_factory, monkeypatch,
):
    monkeypatch.setattr(settings, "fs_browse_roots", "")
    h = await _admin_headers(client)
    uid = await _project(client, h)
    bound = tmp_path_factory.mktemp("bound")
    url = f"{API}/projects/{uid}/folder-bindings"

    no_exec = await _member_with_role(client, db, h, uid, "binder", ["project-settings:read", "project-settings:write"])
    assert (await client.patch(url, headers=no_exec, json={"idePath": str(bound)})).status_code == 403
    assert (await client.patch(url, headers=no_exec, json={"idePath": None})).status_code == 200

    with_exec = await _member_with_role(
        client, db, h, uid, "runner", ["project-settings:read", "project-settings:write", "ide:execute"],
    )
    assert (await client.patch(url, headers=with_exec, json={"idePath": str(bound)})).status_code == 200


async def test_binding_needs_project_settings_write(client, seed_roles, db, tmp_path_factory):
    h = await _admin_headers(client)
    uid = await _project(client, h)
    bound = tmp_path_factory.mktemp("bound")
    reader = await _member_with_role(client, db, h, uid, "reader", ["project-settings:read", "ide:execute"])
    url = f"{API}/projects/{uid}/folder-bindings"
    assert (await client.patch(url, headers=reader, json={"idePath": str(bound)})).status_code == 403
