"""End-to-end git versioning routes: the router is mounted, the access token is
encrypted at rest and never returned, and status/commit report changes."""

import io
import zipfile

from sqlalchemy import select

from app.models.project import Project

API = "/api/v1"


async def _bootstrap_admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _zip(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


async def test_git_token_encrypted_and_never_returned(client, db):
    headers = await _bootstrap_admin(client)
    r = await client.post(
        f"{API}/projects",
        headers=headers,
        json={
            "uid": "p-git-1",
            "name": {"en": "P"},
            "gitRemoteConfig": {"url": "https://x/y.git", "branch": "main", "authToken": "ghp_secret"},
        },
    )
    assert r.status_code == 201
    body = r.json()
    # The token must not round-trip through the API's JSON config.
    assert "authToken" not in body["gitRemoteConfig"]
    assert body["gitRemoteConfig"] == {"url": "https://x/y.git", "branch": "main"}

    # It is stored encrypted (not plaintext) in a dedicated column.
    project = (await db.execute(select(Project).where(Project.uid == "p-git-1"))).scalar_one()
    assert project.git_remote_secret and project.git_remote_secret != "ghp_secret"


async def test_git_status_endpoint_reports_added_files(client):
    """Hitting the status route proves the git router is mounted and gated."""
    headers = await _bootstrap_admin(client)
    await client.post(
        f"{API}/projects",
        headers=headers,
        json={"uid": "p-git-2", "name": {"en": "P2"}},
    )
    files = {"file": ("export.zip", _zip({"project.json": '{"a":1}'}), "application/zip")}
    r = await client.post(f"{API}/git/projects/p-git-2/status", headers=headers, files=files, data={"branch": "main"})
    assert r.status_code == 200
    body = r.json()
    assert body["added"] == 1
    assert body["linked"] is False  # no remote configured
    assert [f["path"] for f in body["files"]] == ["project.json"]


async def test_git_status_requires_auth(client):
    files = {"file": ("export.zip", _zip({"a.txt": "x"}), "application/zip")}
    r = await client.post(f"{API}/git/projects/whatever/status", files=files)
    assert r.status_code in (401, 403)
