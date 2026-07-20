"""Settings-scope git routes: admin-gated, config set/get strips the token, and
status/import work end to end."""

import io
import subprocess
import zipfile

API = "/api/v1"


async def _bootstrap_admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _bare_repo(tmp_path) -> str:
    path = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", "-b", "main", str(path)], check=True, capture_output=True)
    return f"file://{path}"


def _zip(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


async def test_settings_status_requires_admin(client):
    """Unauthenticated → rejected; the scope is account-level (global admin)."""
    r = await client.post(f"{API}/git/settings/account/status", data={"branch": "main"})
    assert r.status_code in (401, 403)


async def test_settings_config_stores_url_never_token(client):
    headers = await _bootstrap_admin(client)
    r = await client.put(
        f"{API}/git/settings/account/config",
        headers=headers,
        json={"url": "https://gitlab.com/g/settings.git", "branch": "main", "authToken": "glpat-x"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body == {"url": "https://gitlab.com/g/settings.git", "branch": "main"}
    assert "authToken" not in body

    # Read it back — still no token in the response.
    r = await client.get(f"{API}/git/settings/account/config", headers=headers)
    assert r.json() == {"url": "https://gitlab.com/g/settings.git", "branch": "main"}


async def test_settings_status_builds_full_tree_and_reports_added(client, tmp_path):
    headers = await _bootstrap_admin(client)
    await client.put(
        f"{API}/git/settings/account/config",
        headers=headers,
        json={"url": _bare_repo(tmp_path), "branch": "main"},
    )
    # No upload — the server assembles organizations/users/roles itself. Which files
    # to actually push is chosen in the panel (per-file), so the tree is always full.
    r = await client.post(
        f"{API}/git/settings/account/status",
        headers=headers,
        data={"branch": "main"},
    )
    assert r.status_code == 200
    body = r.json()
    paths = [f["path"] for f in body["files"]]
    assert body["added"] >= 1
    assert "users.json" in paths
    assert "roles.json" in paths


async def test_settings_export_zip_download(client):
    headers = await _bootstrap_admin(client)
    r = await client.get(f"{API}/git/settings/account/export", headers=headers)
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    # The admin user always exists → users.json is in the tree.
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    assert "users.json" in names and "roles.json" in names


async def test_settings_export_requires_admin(client):
    r = await client.get(f"{API}/git/settings/account/export")
    assert r.status_code in (401, 403)


async def test_settings_import_file_creates_disabled_user(client):
    headers = await _bootstrap_admin(client)
    zip_bytes = _zip({"users.json": '[{"username": "imported", "role": "user"}]'})
    files = {"file": ("settings.zip", zip_bytes, "application/zip")}
    r = await client.post(f"{API}/git/settings/account/import-file", headers=headers, files=files)
    assert r.status_code == 200
    assert r.json()["usersCreated"] == 1

    # The imported account exists and is disabled (no password) — full list is admin-only.
    users = (await client.get(f"{API}/users", headers=headers)).json()
    imported = next(u for u in users if u["username"] == "imported")
    assert imported["isActive"] is False


async def test_settings_pull_preview_requires_remote(client):
    """No remote configured → pull-preview is a clear 400, not a phantom-empty tree."""
    headers = await _bootstrap_admin(client)
    r = await client.get(f"{API}/git/settings/account/pull-preview", headers=headers)
    assert r.status_code == 400


async def test_settings_pull_preview_empty_repo_errors(client, tmp_path):
    """A reachable but empty remote can't be cloned (no branch) → surfaced as a 400
    the UI shows in the pull dialog, rather than looking like 'nothing to pull'."""
    headers = await _bootstrap_admin(client)
    await client.put(
        f"{API}/git/settings/account/config",
        headers=headers,
        json={"url": _bare_repo(tmp_path), "branch": "main"},
    )
    r = await client.get(f"{API}/git/settings/account/pull-preview", headers=headers)
    assert r.status_code == 400
