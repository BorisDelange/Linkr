"""A user's code runs in kernels, the terminal and package installs; none of
them may inherit the API's secrets (docs/design/spe-security.md §1)."""

import json

from app.services.execution.child_env import SECRET_NAMES, child_env

API = "/api/v1"
_SECRETS = {
    "LINKR_SECRET_KEY": "jwt-signing",
    "LINKR_ENCRYPTION_KEY": "aes-key",
    "LINKR_ENCRYPTION_OLD_KEYS": "old",
    "LINKR_DATABASE_URL": "postgresql://linkr:pw@db/linkr",
    "LINKR_GIT_TOKEN": "glpat-x",
    "DATABASE_URL": "postgresql://u:pw@h/db",
    "GITLAB_TOKEN": "glpat-y",
    "AWS_SECRET_ACCESS_KEY": "aws",
}


def test_only_allowlisted_names_pass(monkeypatch):
    for k, v in _SECRETS.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("LC_ALL", "C.UTF-8")
    monkeypatch.setenv("HTTPS_PROXY", "http://user:pw@proxy:3128")
    monkeypatch.setenv("UV_INDEX_URL", "https://mirror/simple")

    env = child_env({"LINKR_PROJECT_UID": "p"})
    assert not set(_SECRETS) & set(env)
    assert env["PATH"] and env["LC_ALL"] == "C.UTF-8" and env["LINKR_PROJECT_UID"] == "p"
    assert "HTTPS_PROXY" not in env and "UV_INDEX_URL" not in env

    provision = child_env(provision=True)
    assert not set(_SECRETS) & set(provision)
    assert provision["HTTPS_PROXY"] and provision["UV_INDEX_URL"]


def test_secret_names_cover_the_settings_that_open_the_instance():
    assert {"LINKR_SECRET_KEY", "LINKR_ENCRYPTION_KEY", "LINKR_ENCRYPTION_OLD_KEYS"} <= SECRET_NAMES


async def test_a_spawned_kernel_sees_no_secret(client, monkeypatch):
    for k, v in _SECRETS.items():
        monkeypatch.setenv(k, v)
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    token = (await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "W"}})).json()["id"]
    uid = (await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]

    r = await client.post(f"{API}/execute", headers=headers, json={
        "language": "python", "projectUid": uid,
        "code": "import os, json; print(json.dumps(sorted(os.environ)))",
    })
    names = set(json.loads(r.json()["stdout"]))
    assert not set(_SECRETS) & names
    assert "LINKR_PROJECT_UID" in names
