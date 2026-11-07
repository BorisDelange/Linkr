"""The read tier of the versioning routes: a reader never writes into an entity's
repository, and the tree they read never carries a resource their role does not read."""

import io
import zipfile

import pytest

from app.core.permissions import _catalogue_perms
from app.services import git_service
from tests.test_ide_files import _admin_headers
from tests.test_workspace_hidden_projects import _member

API = "/api/v1"
MARKER = "tree-read-marker"


def _zip(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


def _git_bytes(repo) -> int:
    git_dir = repo / ".git"
    return sum(p.stat().st_size for p in git_dir.rglob("*") if p.is_file()) if git_dir.is_dir() else 0


async def _workspace_and_project(client, admin) -> tuple[str, str]:
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "WS"}})).json()["id"]
    uid = (await client.post(f"{API}/projects", headers=admin, json={
        "name": {"en": "P"}, "workspaceId": ws, "entityId": "proj",
    })).json()["uid"]
    created = await client.post(f"{API}/ide-files", headers=admin, json={
        "projectUid": uid, "path": "analysis.R", "type": "file", "content": MARKER,
    })
    assert created.status_code == 201
    return ws, uid


READ_FORMS = {
    "status": {"branch": "main"},
    "diff": {"branch": "main", "path": "scripts/analysis.R"},
    "three-way": {"branch": "main"},
    "merged-tree": {"branch": "main", "remoteHead": "a" * 40},
}


# --- a reader's upload --------------------------------------------------------


@pytest.mark.parametrize("route", list(READ_FORMS))
async def test_a_reader_never_writes_an_export_of_their_own_into_the_repository(client, db, route):
    admin = await _admin_headers(client)
    ws, uid = await _workspace_and_project(client, admin)
    _, viewer = await _member(client, db, ws, "vera", "viewer")
    repo = git_service.project_repo_getter(uid)
    assert (await client.post(f"{API}/git/projects/{uid}/status", headers=viewer, data={"branch": "main"})).status_code == 200
    before = _git_bytes(repo)

    r = await client.post(
        f"{API}/git/projects/{uid}/{route}", headers=viewer, data=READ_FORMS[route],
        files={"file": ("export.zip", _zip({"blob.bin": b"\x01" * 200_000}), "application/zip")},
    )

    assert r.status_code == 403, r.text
    assert _git_bytes(repo) == before
    assert not (repo / "blob.bin").exists()


@pytest.mark.parametrize("scope", ["workspaces", "sql-script-collections", "etl-pipelines"])
async def test_a_reader_never_sends_an_export_in_any_scope(client, db, scope):
    admin = await _admin_headers(client)
    ws, _ = await _workspace_and_project(client, admin)
    _, viewer = await _member(client, db, ws, "vera", "viewer")
    if scope == "workspaces":
        entity = ws
    elif scope == "sql-script-collections":
        entity = (await client.post(f"{API}/sql-script-collections", headers=admin, json={
            "id": "coll", "workspaceId": ws, "name": {"en": "C"},
        })).json()["id"]
    else:
        entity = (await client.post(f"{API}/etl-pipelines", headers=admin, json={
            "id": "pipe", "workspaceId": ws, "name": {"en": "E"},
        })).json()["id"]

    r = await client.post(
        f"{API}/git/{scope}/{entity}/status", headers=viewer, data={"branch": "main"},
        files={"file": ("export.zip", _zip({"x.txt": b"x"}), "application/zip")},
    )
    assert r.status_code == 403, r.text
    assert (await client.post(f"{API}/git/{scope}/{entity}/status", headers=viewer, data={"branch": "main"})).status_code == 200


async def test_a_writer_may_still_send_an_export_to_a_read_route(client, db):
    admin = await _admin_headers(client)
    ws, uid = await _workspace_and_project(client, admin)
    _, editor = await _member(client, db, ws, "eddy", "editor")

    r = await client.post(
        f"{API}/git/projects/{uid}/status", headers=editor, data={"branch": "main"},
        files={"file": ("export.zip", _zip({"entity.json": b"{}"}), "application/zip")},
    )
    assert r.status_code == 200, r.text
    assert [f["path"] for f in r.json()["files"]] == ["entity.json"]


async def test_a_reader_still_gets_the_status_the_server_builds(client, db):
    admin = await _admin_headers(client)
    ws, uid = await _workspace_and_project(client, admin)
    _, viewer = await _member(client, db, ws, "vera", "viewer")

    r = await client.post(f"{API}/git/projects/{uid}/status", headers=viewer, data={"branch": "main"})
    assert r.status_code == 200, r.text
    assert "scripts/analysis.R" in [f["path"] for f in r.json()["files"]]


# --- a role narrowed by an admin ------------------------------------------------


async def _narrow_viewer(client, admin, removed: set[str]) -> None:
    roles = (await client.get(f"{API}/roles", headers=admin)).json()
    viewer = next(role for role in roles if role["name"] == "viewer")
    permissions = [p for p in _catalogue_perms("read") if p not in removed]
    r = await client.patch(f"{API}/roles/{viewer['id']}", headers=admin, json={"permissions": permissions})
    assert r.status_code == 200, r.text


async def _viewer(client, admin, ws: str) -> dict:
    bob = (await client.post(f"{API}/users", headers=admin, json={"username": "bob", "password": "pw-for-tests-only"})).json()["id"]
    assert (await client.put(f"{API}/workspaces/{ws}/members", headers=admin, json={"userId": bob, "role": "viewer"})).status_code < 300
    r = await client.post(f"{API}/auth/login", json={"username": "bob", "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.mark.parametrize("route", list(READ_FORMS))
async def test_a_project_tree_never_reaches_a_role_without_its_scripts(client, route):
    admin = await _admin_headers(client)
    ws, uid = await _workspace_and_project(client, admin)
    bob = await _viewer(client, admin, ws)
    await _narrow_viewer(client, admin, {"ide:read"})

    r = await client.post(f"{API}/git/projects/{uid}/{route}", headers=bob, data=READ_FORMS[route])
    assert r.status_code == 403, r.text
    assert MARKER not in r.text
    assert (await client.get(f"{API}/git/projects/{uid}/branches", headers=bob)).status_code == 200


@pytest.mark.parametrize("route", list(READ_FORMS))
async def test_a_workspace_tree_never_reaches_a_role_without_its_sql(client, route):
    admin = await _admin_headers(client)
    ws, _ = await _workspace_and_project(client, admin)
    bob = await _viewer(client, admin, ws)
    await _narrow_viewer(client, admin, {"sql-scripts:read"})

    r = await client.post(f"{API}/git/workspaces/{ws}/{route}", headers=bob, data=READ_FORMS[route])
    assert r.status_code == 403, r.text


async def test_a_workspace_tree_never_carries_a_project_whose_scripts_the_role_does_not_read(client):
    admin = await _admin_headers(client)
    ws, _ = await _workspace_and_project(client, admin)
    bob = await _viewer(client, admin, ws)
    await _narrow_viewer(client, admin, {"ide:read"})

    r = await client.post(f"{API}/git/workspaces/{ws}/diff", headers=bob, data=READ_FORMS["diff"])
    assert r.status_code == 403, r.text
    assert MARKER not in r.text


async def test_the_exports_never_carry_what_the_role_does_not_read(client):
    admin = await _admin_headers(client)
    ws, uid = await _workspace_and_project(client, admin)
    bob = await _viewer(client, admin, ws)
    await _narrow_viewer(client, admin, {"ide:read", "wiki:read"})

    project_zip = await client.get(f"{API}/projects/{uid}/export-zip", headers=bob)
    assert project_zip.status_code == 403
    assert MARKER.encode() not in project_zip.content

    workspace_zip = await client.post(f"{API}/workspaces/{ws}/export-zip", headers=bob, json={})
    assert workspace_zip.status_code == 403
    allowed = await client.post(f"{API}/workspaces/{ws}/export-zip", headers=bob, json={"sections": {"wiki": False}})
    assert allowed.status_code == 200, allowed.text
    with zipfile.ZipFile(io.BytesIO(allowed.content)) as zf:
        assert not any(MARKER.encode() in zf.read(n) for n in zf.namelist())
        assert not any(n.startswith("wiki/") for n in zf.namelist())


async def test_a_viewer_with_every_read_keeps_the_trees_and_the_exports(client):
    admin = await _admin_headers(client)
    ws, uid = await _workspace_and_project(client, admin)
    bob = await _viewer(client, admin, ws)

    assert (await client.post(f"{API}/git/projects/{uid}/status", headers=bob, data={"branch": "main"})).status_code == 200
    assert (await client.post(f"{API}/git/workspaces/{ws}/status", headers=bob, data={"branch": "main"})).status_code == 200
    project_zip = await client.get(f"{API}/projects/{uid}/export-zip", headers=bob)
    assert project_zip.status_code == 200
    with zipfile.ZipFile(io.BytesIO(project_zip.content)) as zf:
        assert any(MARKER.encode() in zf.read(n) for n in zf.namelist())
    workspace_zip = await client.post(f"{API}/workspaces/{ws}/export-zip", headers=bob, json={})
    assert workspace_zip.status_code == 200
    assert workspace_zip.headers.get("x-linkr-projects-left-out", "0") == "0"
