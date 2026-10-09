"""Route-level regressions for what a database's `serverPath`, a project's folder
binding and a server-file import may point at: never Linkr's data folder, and
another project's bound folder only with `project-folders:read`."""

import sqlite3

from app.config import settings
from app.models.project import Project
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


async def test_a_database_cannot_point_inside_linkrs_data_folder(client, seed_roles, tmp_path_factory):
    settings.data_path.mkdir(parents=True, exist_ok=True)
    victim = settings.data_path / "linkr-copy.db"
    _sqlite_with_users(victim)
    h = await _admin_headers(client)
    ws = await _workspace(client, h)

    created = await client.post(f"{API}/data-sources", headers=h, json=_source_body(ws, victim))
    assert created.status_code == 400

    elsewhere = tmp_path_factory.mktemp("server") / "ok.db"
    _sqlite_with_users(elsewhere)
    created = await client.post(f"{API}/data-sources", headers=h, json=_source_body(ws, elsewhere))
    assert created.status_code == 201
    moved = await client.patch(f"{API}/data-sources/{created.json()['id']}", headers=h, json={
        "connectionConfig": {"engine": "sqlite", "serverPath": str(victim)},
    })
    assert moved.status_code == 400


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
    assert r.status_code == 400
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
        return client.patch(f"{API}/projects/{uid}", headers=headers, json={key: str(path)})

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
        "serverPath": str(settings.data_path),
    })
    assert r.status_code == 403
