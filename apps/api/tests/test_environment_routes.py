"""Environment routes: list, package add/list, permission gating, build → job.

The provisioner is monkeypatched so these run without uv/renv or network."""

import pytest

from app.services.execution import environments

API = "/api/v1"


class _FakeProvisioner:
    """In-memory stand-in for uv/renv: records packages, no shelling out."""

    def __init__(self):
        self._pkgs: dict[str, list[dict]] = {}

    def add_packages(self, project_uid, packages):
        self._pkgs.setdefault(project_uid, [])
        self._pkgs[project_uid].extend({"name": p, "spec": ""} for p in packages)

    def remove_package(self, project_uid, package):
        self._pkgs[project_uid] = [
            p for p in self._pkgs.get(project_uid, []) if p["name"] != package
        ]

    def list_packages(self, project_uid):
        return self._pkgs.get(project_uid, [])

    def venv_python(self, project_uid):
        return "/fake/venv/bin/python"

    async def build(self, project_uid, on_log=None):
        from app.services.execution.uv_provisioner import BuildResult

        if on_log:
            on_log("fake build ok")
        return BuildResult(ok=True, log="fake build ok")


@pytest.fixture
def fake_provisioner(monkeypatch):
    fake = _FakeProvisioner()
    monkeypatch.setattr(environments, "_provisioner", lambda language: fake)
    return fake


async def _admin_headers(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _project(client, headers) -> str:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    return (
        await client.post(
            f"{API}/projects",
            headers=headers,
            json={"uid": "proj-1", "name": {"en": "P"}, "workspaceId": ws},
        )
    ).json()["uid"]


async def test_list_environments_seeds_both_languages(client):
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    envs = (await client.get(f"{API}/projects/{uid}/environments", headers=headers)).json()
    assert {e["language"] for e in envs} == {"python", "r"}
    assert all(e["kind"] == "system" for e in envs)


async def test_add_and_list_packages(client, fake_provisioner):
    headers = await _admin_headers(client)
    uid = await _project(client, headers)

    r = await client.post(
        f"{API}/projects/{uid}/environments/python/packages",
        headers=headers,
        json={"packages": ["pandas"]},
    )
    assert r.status_code == 200
    # Adding a package promotes the env to managed.
    assert r.json()["kind"] == "managed"

    pkgs = (
        await client.get(f"{API}/projects/{uid}/environments/python/packages", headers=headers)
    ).json()
    assert [p["name"] for p in pkgs] == ["pandas"]


async def test_unknown_language_is_rejected(client):
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    r = await client.get(f"{API}/projects/{uid}/environments/julia/packages", headers=headers)
    assert r.status_code == 400
