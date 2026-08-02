"""Environment routes: list, package add/list, permission gating, build → job.

The provisioner is monkeypatched so these run without uv/renv or network."""

import pytest

from app.services.execution import environments

API = "/api/v1"


class _FakeProvisioner:
    """In-memory stand-in for uv/renv: records packages, no shelling out."""

    def __init__(self):
        self._pkgs: dict[str, list[dict]] = {}

    def add_packages(self, project_uid, packages, on_log=None, options=None):
        if on_log:
            on_log(f"$ fake add {' '.join(packages)}")
        self._pkgs.setdefault(project_uid, [])
        self._pkgs[project_uid].extend({"name": p, "spec": ""} for p in packages)

    def remove_package(self, project_uid, package, on_log=None, options=None):
        if on_log:
            on_log(f"$ fake remove {package}")
        self._pkgs[project_uid] = [
            p for p in self._pkgs.get(project_uid, []) if p["name"] != package
        ]

    def upgrade(self, project_uid, package=None, on_log=None, options=None):
        if on_log:
            on_log(f"$ fake upgrade {package or 'all'}")

    def list_packages(self, project_uid):
        return self._pkgs.get(project_uid, [])

    def venv_python(self, project_uid):
        return "/fake/venv/bin/python"

    async def build(self, project_uid, on_log=None, options=None):
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


async def test_env_options_get_and_set_roundtrip(client, fake_provisioner, monkeypatch, tmp_path):
    """Setting a per-env override persists it and shows up in the effective options."""
    from app.services.execution import env_options

    monkeypatch.setattr(
        env_options.project_fs,
        "env_spec_dir",
        lambda project_uid, language: tmp_path / project_uid / language,
    )
    headers = await _admin_headers(client)
    uid = await _project(client, headers)

    r = await client.put(
        f"{API}/projects/{uid}/environments/r/options",
        headers=headers,
        json={"repos": "https://mirror.chu/cran", "method": "curl"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["override"] == {"repos": "https://mirror.chu/cran", "method": "curl"}
    assert body["effective"]["repos"] == "https://mirror.chu/cran"

    got = (await client.get(f"{API}/projects/{uid}/environments/r/options", headers=headers)).json()
    assert got["override"]["method"] == "curl"


async def test_add_package_creates_visible_job(client, fake_provisioner):
    """A package add runs as a tracked job — the command it ran shows up in the
    jobs panel so the user can inspect what happened."""
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    await client.post(
        f"{API}/projects/{uid}/environments/python/packages",
        headers=headers,
        json={"packages": ["pandas"]},
    )
    jobs = (await client.get(f"{API}/projects/{uid}/jobs", headers=headers)).json()
    add_jobs = [j for j in jobs if j["kind"] == "package"]
    assert add_jobs, "package op should create a job"
    assert "$ fake add pandas" in add_jobs[0]["logTail"]


async def test_failed_install_returns_clear_error_not_500(client, monkeypatch):
    """A provisioner failure surfaces the real terminal output as a 422, not an
    opaque 500 — and the failing job is kept for inspection."""

    class _FailingProvisioner:
        def add_packages(self, project_uid, packages, on_log=None, options=None):
            if on_log:
                on_log("$ uv add aaa")
                on_log("error: no solution found: package `aaa` was not found")
            from app.services.execution.uv_provisioner import ProvisionError

            raise ProvisionError("$ uv add aaa\nerror: no solution found")

        def list_packages(self, project_uid):
            return []

    monkeypatch.setattr(environments, "_provisioner", lambda language: _FailingProvisioner())
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    r = await client.post(
        f"{API}/projects/{uid}/environments/python/packages",
        headers=headers,
        json={"packages": ["aaa"]},
    )
    assert r.status_code == 422
    assert "no solution found" in r.json()["detail"]

    jobs = (await client.get(f"{API}/projects/{uid}/jobs", headers=headers)).json()
    errored = [j for j in jobs if j["status"] == "error"]
    assert errored and "uv add aaa" in errored[0]["logTail"]


async def test_unknown_language_is_rejected(client):
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    r = await client.get(f"{API}/projects/{uid}/environments/julia/packages", headers=headers)
    assert r.status_code == 400


async def test_injection_package_name_rejected(client, fake_provisioner):
    """A package name with R/shell metacharacters is refused at the API boundary
    (422) — it never reaches the provisioner."""
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    r = await client.post(
        f"{API}/projects/{uid}/environments/r/packages",
        headers=headers,
        json={"packages": ['x"); system("id"); ("']},
    )
    assert r.status_code == 422


async def test_remove_package_injection_rejected(client, fake_provisioner):
    """The {package} path param is validated too (raw R-string interpolation site)."""
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    r = await client.request(
        "DELETE",
        f"{API}/projects/{uid}/environments/r/packages/x')]]%3C-NULL%3Bsystem('id",
        headers=headers,
    )
    assert r.status_code == 400


async def test_code_execution_disabled_blocks_writes(client, fake_provisioner, monkeypatch):
    """With code execution disabled, package/build ops (which shell out) are 403,
    but reads still work."""
    from app.config import settings

    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    monkeypatch.setattr(settings, "enable_code_execution", False)

    r = await client.post(
        f"{API}/projects/{uid}/environments/python/packages",
        headers=headers,
        json={"packages": ["pandas"]},
    )
    assert r.status_code == 403

    r = await client.get(f"{API}/projects/{uid}/environments", headers=headers)
    assert r.status_code == 200  # reads unaffected


async def test_install_preset_records_default_packages(client, fake_provisioner):
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    r = await client.post(
        f"{API}/projects/{uid}/environments/python/preset", headers=headers
    )
    assert r.status_code == 200
    pkgs = (
        await client.get(f"{API}/projects/{uid}/environments/python/packages", headers=headers)
    ).json()
    # The built-in Python data-science default set landed in the env.
    assert "pandas" in {p["name"] for p in pkgs}
    assert "numpy" in {p["name"] for p in pkgs}


async def test_import_env_spec_restores_renv_lock_and_lists_packages(client):
    """A project clone restores environments/r/renv.lock on disk; its recorded
    packages then surface through the packages endpoint (renv list reads the lock,
    no renv binary needed)."""
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    lock = (
        '{"R":{"Version":"4.3.0"},'
        '"Packages":{"dplyr":{"Package":"dplyr","Version":"1.2.1"},'
        '"ggplot2":{"Package":"ggplot2","Version":"4.0.3"}}}'
    )
    r = await client.post(
        f"{API}/projects/{uid}/environments/r/spec",
        headers=headers,
        json={"files": [{"name": "renv.lock", "content": lock}]},
    )
    assert r.status_code == 204

    pkgs = (
        await client.get(f"{API}/projects/{uid}/environments/r/packages", headers=headers)
    ).json()
    by_name = {p["name"]: p["spec"] for p in pkgs}
    # The restored user packages surface from the lockfile...
    assert by_name["dplyr"] == "==1.2.1"
    assert by_name["ggplot2"] == "==4.0.3"
    # ...alongside the kernel infra rows, which are marked system (non-removable).
    system = {p["name"] for p in pkgs if p.get("system")}
    assert {"jsonlite", "base64enc", "svglite"} <= system
    assert not any(p.get("system") for p in pkgs if p["name"] in ("dplyr", "ggplot2"))


async def test_import_env_spec_rejects_unknown_and_traversal_names(client):
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    for bad in ["evil.sh", "../secret", "r/../../etc/passwd"]:
        r = await client.post(
            f"{API}/projects/{uid}/environments/r/spec",
            headers=headers,
            json={"files": [{"name": bad, "content": "x"}]},
        )
        assert r.status_code == 400, bad
