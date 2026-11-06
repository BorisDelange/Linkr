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
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
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
    job = (await client.get(f"{API}/jobs/{add_jobs[0]['id']}", headers=headers)).json()
    assert "$ fake add pandas" in job["logTail"]


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
    assert errored
    job = (await client.get(f"{API}/jobs/{errored[0]['id']}", headers=headers)).json()
    assert "uv add aaa" in job["logTail"]


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


async def test_kernel_package_cannot_be_removed_even_with_a_version_pin(client, fake_provisioner):
    """The infra guard must match on the bare NAME: `jsonlite==1.0` is not in
    _KERNEL_DEPS, so a pinned spec used to walk straight past the check."""
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    for spec in ("jsonlite", "jsonlite==1.0", "svglite%3E%3D2", "base64enc@1.1"):
        r = await client.request(
            "DELETE", f"{API}/projects/{uid}/environments/r/packages/{spec}", headers=headers
        )
        assert r.status_code == 422, spec
        assert "kernel package" in r.json()["detail"]


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


async def test_running_the_package_manager_takes_ide_execute(client, db, fake_provisioner):
    """Resolving, installing and building packages runs their code on the server:
    ide:write alone edits the environment's spec and options, never builds it."""
    from app.core.security import hash_password
    from app.models.project_member import ProjectMember
    from app.models.role import Role
    from app.models.user import User

    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    bob = User(username="bob", password_hash=hash_password("pw-for-tests-only"), role="user")
    db.add(bob)
    db.add(Role(name="ide-writer", scope="workspace", permissions=["projects:read", "ide:read", "ide:write"]))
    await db.commit()
    db.add(ProjectMember(project_uid=uid, user_id=bob.id, role="ide-writer"))
    await db.commit()
    r = await client.post(f"{API}/auth/login", json={"username": "bob", "password": "pw-for-tests-only"})
    bob_h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    base = f"{API}/projects/{uid}/environments/python"

    assert (await client.put(f"{base}/options", headers=bob_h, json={})).status_code == 200
    for method, path, kwargs in (
        ("post", "/build", {}),
        ("post", "/packages", {"json": {"packages": ["pandas"]}}),
        ("delete", "/packages/pandas", {}),
        ("post", "/preset", {}),
        ("post", "/upgrade", {}),
    ):
        r = await getattr(client, method)(f"{base}{path}", headers=bob_h, **kwargs)
        assert r.status_code == 403, path
    assert (await client.post(f"{base}/build", headers=headers)).status_code == 200


async def _member(client, db, uid: str, name: str, permissions: list[str]) -> dict:
    from app.core.security import hash_password
    from app.models.project_member import ProjectMember
    from app.models.role import Role
    from app.models.user import User

    user = User(username=name, password_hash=hash_password("pw-for-tests-only"), role="user")
    db.add(user)
    db.add(Role(name=f"{name}-role", scope="workspace", permissions=permissions))
    await db.commit()
    db.add(ProjectMember(project_uid=uid, user_id=user.id, role=f"{name}-role"))
    await db.commit()
    r = await client.post(f"{API}/auth/login", json={"username": name, "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
def update_check(monkeypatch):
    """The options each update check reached the package manager with."""
    from app.services.execution import renv_provisioner

    seen: list[dict | None] = []

    def fake(project_uid=None, options=None):
        seen.append(options)
        return {}

    monkeypatch.setattr(renv_provisioner, "check_updates", fake)
    monkeypatch.setattr(renv_provisioner, "check_kernel_updates", lambda options=None: fake(options=options))
    return seen


async def test_checking_for_updates_runs_the_package_manager_so_takes_its_permissions(client, db, update_check):
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    base = f"{API}/projects/{uid}/environments/r"
    viewer = await _member(client, db, uid, "viewer", ["projects:read", "ide:read"])
    writer = await _member(client, db, uid, "writer", ["projects:read", "ide:read", "ide:write"])

    assert (await client.post(f"{base}/updates", headers=viewer)).status_code == 403
    assert (await client.post(f"{base}/updates", headers=writer)).status_code == 403
    assert update_check == []
    assert (await client.get(f"{base}/updates", headers=viewer)).status_code == 200

    assert (await client.post(f"{base}/updates", headers=headers)).status_code == 200
    assert update_check


async def test_checking_for_updates_honours_the_code_execution_switch(client, update_check, monkeypatch):
    from app.config import settings

    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    monkeypatch.setattr(settings, "enable_code_execution", False)

    assert (await client.post(f"{API}/projects/{uid}/environments/r/updates", headers=headers)).status_code == 403
    assert update_check == []


async def test_checking_for_updates_uses_the_options_a_build_would(client, update_check, monkeypatch):
    from app.config import settings
    from app.services.execution import env_options

    monkeypatch.setattr(settings, "r_repos", "https://mirror.internal/cran")
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    env_options.write_env_override(uid, "r", {"repos": "https://other.example/cran"})

    r = await client.post(f"{API}/projects/{uid}/environments/r/updates", headers=headers)

    assert r.status_code == 200
    assert update_check and {o["repos"] for o in update_check} == {"https://mirror.internal/cran"}


async def test_install_options_never_return_index_credentials(client, db, monkeypatch):
    from app.config import settings
    from app.services.execution import env_options

    secret = "https://a.example/cran,https://u:s3cret@b.example/cran"
    monkeypatch.setattr(settings, "r_repos", secret)
    headers = await _admin_headers(client)
    uid = await _project(client, headers)
    viewer = await _member(client, db, uid, "viewer", ["projects:read", "ide:read"])
    url = f"{API}/projects/{uid}/environments/r/options"

    assert "s3cret" not in (await client.get(url, headers=viewer)).text
    assert "s3cret" not in (await client.get(url, headers=headers)).text

    r = await client.put(url, headers=headers, json={"repos": "https://u:s3cret@b.example/cran"})
    assert "s3cret" not in r.text
    assert env_options.read_env_override(uid, "r")["repos"] == "https://u:s3cret@b.example/cran"

    await client.put(url, headers=headers, json=r.json()["override"])
    assert env_options.read_env_override(uid, "r")["repos"] == "https://u:s3cret@b.example/cran"


async def test_a_workspace_default_never_returns_index_credentials(client):
    headers = await _admin_headers(client)
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    options = {"r": {"repos": "https://u:s3cret@b.example/cran"}, "python": {"indexUrl": "https://u:s3cret@c.example/simple"}}

    r = await client.patch(f"{API}/workspaces/{ws}", headers=headers, json={"defaultEnvOptions": options})
    assert r.status_code == 200 and "s3cret" not in r.text
    sent_back = r.json()["defaultEnvOptions"]
    assert sent_back["r"]["repos"] == "https://***@b.example/cran"

    assert (await client.patch(f"{API}/workspaces/{ws}", headers=headers, json={"defaultEnvOptions": sent_back})).status_code == 200
    from app.core.database import async_session
    from app.models.workspace import Workspace

    async with async_session() as session:
        stored = (await session.get(Workspace, ws)).default_env_options
    assert stored == options
