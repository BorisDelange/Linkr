"""A project hidden from a workspace member by a 'none' override stays hidden on
every workspace-level path to its content: the export, the versioning routes and
the workspace-wide README cleanup."""

import io
import zipfile

import pytest
from sqlalchemy import select

from app.api.v1.routes import git as git_routes
from app.core.security import hash_password
from app.models.attachment import ReadmeAttachment
from app.models.project_member import ProjectMember
from app.models.user import User
from app.models.workspace_member import WorkspaceMember
from app.services import attachment_service
from tests.test_ide_files import _admin_headers

API = "/api/v1"
MARKER = "hidden-project-marker"


async def _member(client, db, ws: str, username: str, role: str) -> tuple[int, dict]:
    user = User(username=username, password_hash=hash_password("pw-for-tests-only"), role="user")
    db.add(user)
    await db.flush()
    db.add(WorkspaceMember(workspace_id=ws, user_id=user.id, role=role))
    await db.commit()
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw-for-tests-only"})
    return user.id, {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _hide(db, project_uid: str, user_id: int) -> None:
    db.add(ProjectMember(project_uid=project_uid, user_id=user_id, role="none"))
    await db.commit()


async def _workspace_with_projects(client, admin) -> tuple[str, str, str]:
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "WS"}})).json()["id"]
    hidden = (await client.post(f"{API}/projects", headers=admin, json={
        "name": {"en": "Secret"}, "workspaceId": ws, "entityId": "secret-project", "readme": MARKER,
    })).json()["uid"]
    visible = (await client.post(f"{API}/projects", headers=admin, json={
        "name": {"en": "Open"}, "workspaceId": ws, "entityId": "open-project", "readme": "open-readme",
    })).json()["uid"]
    created = await client.post(f"{API}/ide-files", headers=admin, json={
        "projectUid": hidden, "path": "secret.R", "type": "file", "content": MARKER,
    })
    assert created.status_code == 201
    return ws, hidden, visible


def _zip_entries(data: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return {name: zf.read(name) for name in zf.namelist()}


async def test_workspace_export_leaves_out_a_project_the_caller_cannot_read(client, db, seed_roles):
    admin = await _admin_headers(client)
    ws, hidden, _visible = await _workspace_with_projects(client, admin)
    bob_id, bob = await _member(client, db, ws, "bob", "viewer")
    await _hide(db, hidden, bob_id)

    r = await client.post(f"{API}/workspaces/{ws}/export-zip", headers=bob, json={})
    assert r.status_code == 200, r.text
    entries = _zip_entries(r.content)
    assert not any("secret-project" in path for path in entries)
    assert not any(MARKER.encode() in content for content in entries.values())
    assert any("open-project" in path for path in entries)

    full = _zip_entries((await client.post(f"{API}/workspaces/{ws}/export-zip", headers=admin, json={})).content)
    assert any("secret-project" in path for path in full)


async def test_workspace_export_keeps_every_project_for_a_member_who_reads_them(client, db, seed_roles):
    admin = await _admin_headers(client)
    ws, _hidden, _visible = await _workspace_with_projects(client, admin)
    _bob_id, bob = await _member(client, db, ws, "bob", "viewer")

    entries = _zip_entries((await client.post(f"{API}/workspaces/{ws}/export-zip", headers=bob, json={})).content)
    assert any("secret-project" in path for path in entries)


READ_ROUTES = [
    ("status", {}),
    ("diff", {"path": "projects/secret-project/README.md"}),
    ("three-way", {}),
    ("merged-tree", {"remoteHead": "abc"}),
]


@pytest.mark.parametrize("route,form", READ_ROUTES)
async def test_workspace_versioning_reads_refuse_a_caller_with_a_hidden_project(client, db, seed_roles, route, form):
    admin = await _admin_headers(client)
    ws, hidden, _visible = await _workspace_with_projects(client, admin)
    bob_id, bob = await _member(client, db, ws, "bob", "viewer")
    await _hide(db, hidden, bob_id)

    r = await client.post(f"{API}/git/workspaces/{ws}/{route}", headers=bob, data=form)
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["code"] == "hidden_projects"
    assert MARKER not in r.text

    uploaded = await client.post(
        f"{API}/git/workspaces/{ws}/{route}", headers=bob, data=form,
        files={"file": ("w.zip", io.BytesIO(b"PK"), "application/zip")},
    )
    assert uploaded.status_code == 403


@pytest.mark.parametrize("route,form", [
    ("commit-push", {"message": "m"}),
    ("propose", {"title": "t"}),
])
async def test_workspace_versioning_writes_refuse_a_caller_with_a_hidden_project(
    client, db, seed_roles, monkeypatch, route, form,
):
    monkeypatch.setattr(git_routes, "GIT_PROPOSALS_ENABLED", True)
    admin = await _admin_headers(client)
    ws, hidden, _visible = await _workspace_with_projects(client, admin)
    await client.patch(f"{API}/workspaces/{ws}", headers=admin, json={
        "gitRemoteConfig": {"url": "https://example.invalid/repo.git", "branch": "main"},
    })
    bob_id, bob = await _member(client, db, ws, "bob", "owner")
    await _hide(db, hidden, bob_id)

    r = await client.post(f"{API}/git/workspaces/{ws}/{route}", headers=bob, data=form)
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["code"] == "hidden_projects"


async def test_workspace_status_still_answers_a_member_who_reads_every_project(client, db, seed_roles):
    admin = await _admin_headers(client)
    ws, _hidden, _visible = await _workspace_with_projects(client, admin)
    _bob_id, bob = await _member(client, db, ws, "bob", "viewer")

    r = await client.post(f"{API}/git/workspaces/{ws}/status", headers=bob)
    assert r.status_code == 200, r.text
    assert r.json()["linked"] is False


async def test_workspace_readme_cleanup_is_held_to_the_right_to_delete_the_workspace(client, db, seed_roles):
    admin = await _admin_headers(client)
    ws, hidden, _visible = await _workspace_with_projects(client, admin)
    bob_id, bob = await _member(client, db, ws, "bob", "editor")
    await _hide(db, hidden, bob_id)
    await attachment_service.create_readme(
        db, id="att-hidden", owner_type="project", owner_id=hidden, workspace_id=ws,
        file_name="a.txt", mime_type="text/plain", created_at=None, data=MARKER.encode(),
    )

    refused = await client.delete(f"{API}/readme-attachments", headers=bob, params={"workspaceId": ws})
    assert refused.status_code == 403
    rows = (await db.execute(select(ReadmeAttachment).where(ReadmeAttachment.id == "att-hidden"))).scalars().all()
    assert len(rows) == 1

    allowed = await client.delete(f"{API}/readme-attachments", headers=admin, params={"workspaceId": ws})
    assert allowed.status_code == 204


async def test_workspace_export_states_how_many_projects_were_left_out(client, db, seed_roles):
    admin = await _admin_headers(client)
    ws, hidden, _visible = await _workspace_with_projects(client, admin)
    bob_id, bob = await _member(client, db, ws, "bob", "viewer")
    await _hide(db, hidden, bob_id)

    r = await client.post(f"{API}/workspaces/{ws}/export-zip", headers=bob, json={})
    assert r.status_code == 200, r.text
    assert r.headers["x-linkr-projects-left-out"] == "1"
    assert hidden not in str(r.headers) and "secret-project" not in str(r.headers)

    full = await client.post(f"{API}/workspaces/{ws}/export-zip", headers=admin, json={})
    assert full.headers["x-linkr-projects-left-out"] == "0"

    # Nothing is left out for the caller when no project was asked for.
    no_projects = await client.post(f"{API}/workspaces/{ws}/export-zip", headers=bob, json={"sections": {"projects": False}})
    assert no_projects.headers["x-linkr-projects-left-out"] == "0"


def test_the_left_out_count_is_readable_across_origins():
    from app.main import app

    cors = next(m for m in app.user_middleware if m.cls.__name__ == "CORSMiddleware")
    assert "x-linkr-projects-left-out" in cors.kwargs["expose_headers"]
