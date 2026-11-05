"""Settings-scope git routes: admin-gated, config set/get strips the token, and
status/import work end to end."""

import io
import subprocess
import zipfile

API = "/api/v1"


async def _bootstrap_admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
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

    # The token WAS stored per (user, host): linking from Import (which sends the
    # token alongside the config) means the Versioning tab can push without re-typing
    # it. host-token status for the same host reports it's present.
    r = await client.get(
        f"{API}/git/host-token?url=https://gitlab.com/g/settings.git", headers=headers
    )
    assert r.json()["hasToken"] is True


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


async def test_settings_three_way_requires_remote(client):
    """No remote configured → the pull is a clear 400, not a phantom-empty tree."""
    headers = await _bootstrap_admin(client)
    r = await client.post(f"{API}/git/settings/account/three-way", headers=headers, data={"branch": "main"})
    assert r.status_code == 400


def _git(cwd, *args) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


async def test_settings_pull_takes_a_colleagues_new_user_through_the_merged_tree(client, tmp_path):
    """Settings pull through the shared 3-way: a user a colleague added upstream is
    offered as one element of users.json, and re-importing the merged tree creates it."""
    import json

    headers = await _bootstrap_admin(client)
    remote = _bare_repo(tmp_path)
    await client.put(f"{API}/git/settings/account/config", headers=headers, json={"url": remote, "branch": "main"})
    r = await client.post(f"{API}/git/settings/account/commit-push", headers=headers, data={"message": "Settings", "branch": "main"})
    assert r.status_code == 200, r.text

    work = tmp_path / "colleague"
    _git(tmp_path, "clone", "-q", "-b", "main", remote, str(work))
    users = json.loads((work / "users.json").read_text())
    users.append({"username": "colleague", "role": "user", "firstName": "Col", "lastName": "League"})
    (work / "users.json").write_text(json.dumps(users, indent=2))
    _git(work, "-c", "user.email=c@x", "-c", "user.name=c", "commit", "-qam", "Add a user")
    _git(work, "push", "-q", "origin", "main")

    r = await client.post(f"{API}/git/settings/account/three-way", headers=headers, data={"branch": "main"})
    assert r.status_code == 200, r.text
    preview = r.json()
    assert [f["path"] for f in preview["files"]] == ["users.json"]

    r = await client.post(
        f"{API}/git/settings/account/merged-tree", headers=headers,
        data={"branch": "main", "remoteHead": preview["remoteHead"], "overrides": json.dumps({"users.json": {"remote": True}})},
    )
    assert r.status_code == 200
    files = {"file": ("settings.zip", r.content, "application/zip")}
    r = await client.post(f"{API}/git/settings/account/import-file", headers=headers, files=files)
    assert r.json()["usersCreated"] == 1
    assert any(u["username"] == "colleague" for u in (await client.get(f"{API}/users", headers=headers)).json())
