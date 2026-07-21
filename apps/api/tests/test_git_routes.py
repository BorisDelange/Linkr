"""End-to-end git versioning routes: the router is mounted, the access token is
stored per user (never on the entity, never returned), and status/commit report
changes."""

import io
import subprocess
import zipfile

from sqlalchemy import select

from app.models.git_credential import GitCredential
from app.models.project import Project

API = "/api/v1"


async def _bootstrap_admin(client) -> dict:
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw"}
    )
    r = await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "pw"}
    )
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _bare_repo(tmp_path) -> str:
    """A reachable, empty git remote (file:// URL). status/diff now surface an auth
    failure when a private remote can't be read, so a bogus URL no longer stands in
    for 'empty remote' — an initialized bare repo does: ls-remote succeeds with no
    branch, so the server-built tree shows as freshly added files (first push)."""
    path = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", "-b", "main", str(path)], check=True, capture_output=True)
    return f"file://{path}"


def _zip(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


async def test_git_token_never_persisted_on_entity(client, db):
    headers = await _bootstrap_admin(client)
    r = await client.post(
        f"{API}/projects",
        headers=headers,
        json={
            "uid": "p-git-1",
            "name": {"en": "P"},
            "gitRemoteConfig": {
                "url": "https://x/y.git",
                "branch": "main",
                "authToken": "ghp_secret",
            },
        },
    )
    assert r.status_code == 201
    body = r.json()
    # The token must not round-trip through the API's JSON config...
    assert "authToken" not in body["gitRemoteConfig"]
    assert body["gitRemoteConfig"] == {"url": "https://x/y.git", "branch": "main"}
    # ...and the entity no longer carries any token column (it's per-user now).
    assert not hasattr(Project, "git_remote_secret")


async def test_host_token_is_stored_per_user_and_not_returned(client, db):
    headers = await _bootstrap_admin(client)
    # Store a token for a host via the per-user endpoint.
    r = await client.put(
        f"{API}/git/host-token",
        headers=headers,
        json={"url": "https://gitlab.com/group/repo.git", "token": "glpat-secret"},
    )
    assert r.status_code == 200
    assert r.json() == {"host": "gitlab.com", "hasToken": True}

    # Status endpoint reports the token is present (never the token itself).
    r = await client.get(
        f"{API}/git/host-token?url=https://gitlab.com/other/repo", headers=headers
    )
    assert r.json() == {"host": "gitlab.com", "hasToken": True}

    # Stored encrypted, keyed to the acting (admin) user.
    row = (await db.execute(select(GitCredential))).scalar_one()
    assert row.host == "gitlab.com"
    assert row.secret and row.secret != "glpat-secret"

    # Clearing removes it.
    r = await client.put(
        f"{API}/git/host-token",
        headers=headers,
        json={"url": "https://gitlab.com/group/repo.git", "token": ""},
    )
    assert r.json()["hasToken"] is False
    assert (await db.execute(select(GitCredential))).first() is None


async def test_git_status_endpoint_reports_added_files(client):
    """Hitting the status route proves the git router is mounted and gated."""
    headers = await _bootstrap_admin(client)
    await client.post(
        f"{API}/projects",
        headers=headers,
        json={"uid": "p-git-2", "name": {"en": "P2"}},
    )
    files = {
        "file": ("export.zip", _zip({"project.json": '{"a":1}'}), "application/zip")
    }
    r = await client.post(
        f"{API}/git/projects/p-git-2/status",
        headers=headers,
        files=files,
        data={"branch": "main"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["added"] == 1
    assert body["linked"] is False  # no remote configured
    assert [f["path"] for f in body["files"]] == ["project.json"]
    # Each file carries its byte size (drives LFS tracking in the UI).
    assert body["files"][0]["size"] == len('{"a":1}')


async def test_git_status_requires_auth(client):
    files = {"file": ("export.zip", _zip({"a.txt": "x"}), "application/zip")}
    r = await client.post(f"{API}/git/projects/whatever/status", files=files)
    assert r.status_code in (401, 403)


async def test_project_set_and_read_sync_state(client, db):
    """The project pull needs a sync anchor: set-sync-state must persist the oid and
    sync-state must read it back (behind/diverged detection). Both are project-scoped
    additions — the mapping-project routes already had them."""
    from app.services import git_sync_state_service

    headers = await _bootstrap_admin(client)
    await client.post(
        f"{API}/projects",
        headers=headers,
        json={"uid": "p-git-sync", "name": {"en": "PS"}},
    )

    r = await client.post(
        f"{API}/git/projects/p-git-sync/set-sync-state",
        headers=headers,
        json={"branch": "main", "syncedOid": "deadbeef"},
    )
    assert r.status_code == 204

    row = await git_sync_state_service.get(db, "projects", "p-git-sync", "main")
    assert row is not None and row.synced_oid == "deadbeef"

    # sync-state is reachable and reports "unlinked" (no remote) rather than 404.
    r = await client.get(
        f"{API}/git/projects/p-git-sync/sync-state",
        headers=headers,
        params={"branch": "main"},
    )
    assert r.status_code == 200
    assert r.json()["linked"] is False


async def test_project_set_sync_state_requires_auth(client):
    r = await client.post(
        f"{API}/git/projects/whatever/set-sync-state",
        json={"branch": "main", "syncedOid": "x"},
    )
    assert r.status_code in (401, 403)


async def test_git_mapping_project_scope(client, db, tmp_path):
    """The mapping-project git scope is mounted, token is encrypted, status runs."""
    from sqlalchemy import select

    from app.models.mapping_project import MappingProject

    headers = await _bootstrap_admin(client)
    ws = (
        await client.post(
            f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}}
        )
    ).json()["id"]
    await client.post(
        f"{API}/mapping-projects",
        headers=headers,
        json={
            "id": "mp-git-1",
            "workspaceId": ws,
            "name": {"en": "M"},
            "description": {},
            "sourceType": "database",
            "dataSourceId": "src-1",
            "conceptSetIds": [],
            "gitRemoteConfig": {
                "url": _bare_repo(tmp_path),
                "branch": "main",
                "authToken": "glpat-secret",
            },
        },
    )
    # Token stripped from the persisted config; the entity carries no token column.
    mp = (
        await db.execute(select(MappingProject).where(MappingProject.id == "mp-git-1"))
    ).scalar_one()
    assert "authToken" not in (mp.git_remote_config or {})
    assert not hasattr(MappingProject, "git_remote_secret")

    files = {
        "file": ("export.zip", _zip({"mapping-project.json": "{}"}), "application/zip")
    }
    r = await client.post(
        f"{API}/git/mapping-projects/mp-git-1/status",
        headers=headers,
        files=files,
        data={"branch": "main"},
    )
    assert r.status_code == 200
    assert r.json()["added"] == 1


async def test_git_mapping_project_status_builds_zip_server_side(client, tmp_path):
    """No uploaded file → the server assembles the export ZIP itself (fullstack
    path that offloads the browser). status reports the server-built tree."""
    headers = await _bootstrap_admin(client)
    ws = (
        await client.post(
            f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}}
        )
    ).json()["id"]
    await client.post(
        f"{API}/mapping-projects",
        headers=headers,
        json={
            "id": "mp-git-srv",
            "workspaceId": ws,
            "name": {"en": "M"},
            "description": {},
            "sourceType": "database",
            "dataSourceId": "src-1",
            "conceptSetIds": [],
            "gitRemoteConfig": {
                "url": _bare_repo(tmp_path),
                "branch": "main",
                "authToken": "glpat-secret",
            },
        },
    )
    # No `files` — the server builds project.json + mappings.json + .gitignore.
    r = await client.post(
        f"{API}/git/mapping-projects/mp-git-srv/status",
        headers=headers,
        data={"branch": "main"},
    )
    assert r.status_code == 200
    # A fresh repo sees the server-built tree as added files (at least the 3 core ones).
    assert r.json()["added"] >= 3


async def test_git_status_surfaces_error_for_unreadable_remote(client):
    """A remote that can't be read (bad host / auth) must NOT be mistaken for an
    empty repo (every file 'added') — status returns an error so the UI can block
    the file view and ask for a token instead of pushing over a phantom-empty repo."""
    headers = await _bootstrap_admin(client)
    ws = (
        await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})
    ).json()["id"]
    await client.post(
        f"{API}/mapping-projects",
        headers=headers,
        json={
            "id": "mp-git-bad",
            "workspaceId": ws,
            "name": {"en": "M"},
            "description": {},
            "sourceType": "database",
            "dataSourceId": "src-1",
            "conceptSetIds": [],
            # Unresolvable host → ls-remote fails; previously this silently looked empty.
            "gitRemoteConfig": {"url": "https://nonexistent.invalid/x/y.git", "branch": "main"},
        },
    )
    r = await client.post(
        f"{API}/git/mapping-projects/mp-git-bad/status",
        headers=headers,
        data={"branch": "main"},
    )
    assert r.status_code == 400
    assert "code" in r.json()["detail"]
