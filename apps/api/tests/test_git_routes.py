"""End-to-end git versioning routes: the router is mounted, the access token is
stored per user (never on the entity, never returned), and status/commit report
changes."""

import io
import subprocess
import zipfile
from pathlib import Path

import pytest
from sqlalchemy import select

from app.core.security import hash_password
from app.models.git_credential import GitCredential
from app.models.project import Project
from app.models.user import User

API = "/api/v1"


async def _bootstrap_admin(client) -> dict:
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"}
    )
    r = await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"}
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
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    r = await client.post(
        f"{API}/projects",
        headers=headers,
        json={"workspaceId": ws,
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
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    await client.post(
        f"{API}/projects",
        headers=headers,
        json={"workspaceId": ws, "uid": "p-git-2", "name": {"en": "P2"}},
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
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    await client.post(
        f"{API}/projects",
        headers=headers,
        json={"workspaceId": ws, "uid": "p-git-sync", "name": {"en": "PS"}},
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


def test_cloned_oid_header_is_exposed_to_the_browser():
    """X-Git-Cloned-Oid must be in CORSMiddleware's expose_headers.

    The clone route sets the header, and the import/pull flows anchor the entity's
    sync state to it. But a custom response header is invisible to JS unless CORS
    exposes it, and the middleware OVERWRITES any Access-Control-Expose-Headers the
    route sets — so the route setting it itself did nothing. The client read null,
    the anchor never moved, and a completed pull still reported "behind" and blocked
    the next push with "pull first". Every clone-based flow was affected (projects
    and ETL pulls, catalog install, workspace import, content retry)."""
    from fastapi.middleware.cors import CORSMiddleware

    from app.main import app

    exposed: list[str] | None = None
    for mw in app.user_middleware:
        if mw.cls is CORSMiddleware:
            exposed = [h.lower() for h in mw.kwargs.get("expose_headers", [])]
    assert exposed is not None, "CORS middleware not installed"
    assert "x-git-cloned-oid" in exposed


def _local_repo_with_secret(tmp_path) -> Path:
    repo = tmp_path / "server-side"
    subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
    (repo / "secret.txt").write_text("server file")
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(
        ["git", "-C", str(repo), "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qm", "c"],
        check=True,
    )
    return repo


async def _user(client, db, username: str) -> dict:
    db.add(User(username=username, password_hash=hash_password("pw-for-tests-only"), role="user"))
    await db.commit()
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.mark.parametrize("form", ["path", "file", "ext"])
async def test_clone_refuses_local_and_non_network_remotes(client, tmp_path, monkeypatch, form):
    # A local path or file:// remote had the server clone a repository sitting on
    # its own disk and hand it back as a ZIP.
    from app.services import git_service

    monkeypatch.setattr(git_service, "_LOCAL_REMOTES_ALLOWED", False)
    admin = await _bootstrap_admin(client)
    repo = _local_repo_with_secret(tmp_path)
    url = {"path": str(repo), "file": f"file://{repo}", "ext": f"ext::sh -c touch% {tmp_path}/pwned"}[form]

    r = await client.post(f"{API}/git/clone", headers=admin, json={"url": url, "branch": "main"})
    assert r.status_code == 400
    assert b"server file" not in r.content
    assert not (tmp_path / "pwned").exists()
    r = await client.post(f"{API}/git/verify-remote", headers=admin, json={"url": url})
    assert r.status_code == 400


def test_only_https_and_ssh_remotes_pass(monkeypatch):
    from app.services import git_service as g

    monkeypatch.setattr(g, "_LOCAL_REMOTES_ALLOWED", False)
    for ok in ("https://framagit.org/g/r.git", "ssh://git@framagit.org/g/r.git", "git@framagit.org:g/r.git"):
        g._require_network_remote(ok)
    for bad in ("http://framagit.org/g/r.git", "/srv/repo", "file:///srv/repo", "ext::sh -c id",
                "git@-oProxyCommand=id:x", "ssh://-oProxyCommand=id/x", "C:/repo"):
        with pytest.raises(g.GitError):
            g._require_network_remote(bad)
    env = g._git_env()
    assert env["GIT_ALLOW_PROTOCOL"] == "https:ssh"
    assert ("http.followRedirects", "false") in [
        (env[f"GIT_CONFIG_KEY_{i}"], env[f"GIT_CONFIG_VALUE_{i}"]) for i in range(int(env["GIT_CONFIG_COUNT"]))
    ]


async def test_clone_and_verify_need_a_write_permission(client, db, tmp_path):
    admin = await _bootstrap_admin(client)
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "WS"}})).json()["id"]
    bob = await _user(client, db, "bob")
    carol = await _user(client, db, "carol")
    bob_id = (await client.get(f"{API}/auth/me", headers=bob)).json()["id"]
    carol_id = (await client.get(f"{API}/auth/me", headers=carol)).json()["id"]
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin, json={"userId": bob_id, "role": "editor"})
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin, json={"userId": carol_id, "role": "viewer"})
    url = f"file://{_local_repo_with_secret(tmp_path)}"

    for route, extra in (("clone", {"branch": "main"}), ("verify-remote", {})):
        assert (await client.post(f"{API}/git/{route}", headers=bob, json={"url": url, **extra})).status_code == 403
        assert (await client.post(f"{API}/git/{route}", headers=carol, json={"url": url, "workspaceId": ws, **extra})).status_code == 403
        assert (await client.post(f"{API}/git/{route}", headers=bob, json={"url": url, "workspaceId": ws, **extra})).status_code == 200
        assert (await client.post(f"{API}/git/{route}", headers=admin, json={"url": url, **extra})).status_code == 200
