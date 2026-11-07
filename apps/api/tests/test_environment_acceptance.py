"""A project's stored environment spec is code the server runs when it builds it.

A run that finds a declared environment not yet built builds it first. That build
runs package code the spec names, so it waits for the running user's acceptance of
exactly that spec, in that project, whoever wrote it: an import, a pull, or a
member allowed to edit the spec but not to run code. Building or changing the
packages oneself, with ide:execute, counts as that acceptance.
"""

import asyncio

import pytest
from starlette.websockets import WebSocketDisconnect

from app.api.v1.routes import execution as execution_routes
from app.services.execution import environments, runtime
from app.services.execution import kernel as kernel_module
from app.services.execution.uv_provisioner import BuildResult

API = "/api/v1"
CODE = "print('accepted text')"
PYPROJECT = '[project]\nname = "x"\nversion = "0"\ndependencies = ["innerpkg"]\n'
LOCK = 'version = 1\nrevision = 3\nrequires-python = ">=3.10"\n'


class _Provisioner:
    def __init__(self):
        self.built: set[str] = set()
        self.builds: list[str] = []

    def list_packages(self, project_uid):
        return [{"name": "innerpkg", "spec": ""}]

    def is_built(self, project_uid):
        return project_uid in self.built

    def venv_python(self, project_uid):
        return "/fake/venv/bin/python"

    def library_path(self, project_uid):
        return "/fake/lib"

    def add_packages(self, project_uid, packages, on_log=None, options=None):
        from app.services import project_fs

        spec = project_fs.env_spec_dir(project_uid, "python")
        (spec / "pyproject.toml").write_text(PYPROJECT.replace('"innerpkg"', '"innerpkg", ' + ", ".join(f'"{p}"' for p in packages)))

    async def build(self, project_uid, on_log=None, options=None):
        self.builds.append(project_uid)
        self.built.add(project_uid)
        return BuildResult(ok=True, log="built")


@pytest.fixture
def prov(monkeypatch, client) -> _Provisioner:
    from app.api.v1.routes import environments as environment_routes
    from app.core import database

    # The build route's job opens its own session.
    monkeypatch.setattr(environment_routes, "async_session", database.async_session)
    fake = _Provisioner()
    monkeypatch.setattr(environments, "_provisioner", lambda language: fake)
    output = runtime.RuntimeOutput(stdout="ok", stderr="", figures=[], table=None, html=None)

    async def run_ephemeral(language, project_uid, code, environment=None, resolver=None):
        return output

    class FakeKernel:
        async def execute(self, code, query_resolver=None):
            return output

        async def execute_stream(self, code, on_chunk, query_resolver=None):
            return output

        def interrupt(self):
            pass

    async def get_kernel(*args, **kwargs):
        return FakeKernel()

    async def spawn_batch(*args, **kwargs):
        return FakeKernel()

    monkeypatch.setattr(kernel_module, "run_ephemeral", run_ephemeral)
    monkeypatch.setattr(kernel_module.manager, "get", get_kernel)
    monkeypatch.setattr(kernel_module.manager, "spawn_batch", spawn_batch)
    return fake


async def _login(client, username: str) -> dict:
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    return await _login(client, "admin")


async def _project(client, headers, workspace: str | None = None) -> str:
    ws = workspace or (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "W"}})).json()["id"]
    return (await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]


async def _plant(client, headers, uid: str, pyproject: str = PYPROJECT):
    r = await client.post(
        f"{API}/projects/{uid}/environments/python/spec",
        headers=headers,
        json={"files": [{"name": "pyproject.toml", "content": pyproject}, {"name": "uv.lock", "content": LOCK}]},
    )
    assert r.status_code == 204, r.text


def _widget(uid: str) -> dict:
    return {"language": "python", "code": CODE, "projectUid": uid, "purpose": "dashboards", "ephemeral": True}


def _ide(uid: str) -> dict:
    return {"language": "python", "code": "1 + 1", "projectUid": uid, "purpose": "ide"}


async def _accept(client, headers, text: str):
    assert (await client.post(f"{API}/code-acceptances", headers=headers, json={"codes": [text]})).status_code == 204


async def _build_jobs(client, headers, uid: str) -> list[dict]:
    return [j for j in (await client.get(f"{API}/projects/{uid}/jobs", headers=headers)).json() if j["kind"] == "build"]


def _refusal(r) -> dict:
    assert r.status_code == 428, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "environment_acceptance_required"
    assert detail["language"] == "python"
    return detail


async def test_a_stored_environment_waits_for_the_runners_acceptance_before_it_builds(client, prov):
    admin = await _admin(client)
    uid = await _project(client, admin)
    await _accept(client, admin, CODE)
    await _plant(client, admin, uid)

    detail = _refusal(await client.post(f"{API}/execute", headers=admin, json=_widget(uid)))
    assert PYPROJECT in detail["spec"] and LOCK in detail["spec"]
    _refusal(await client.post(f"{API}/execute", headers=admin, json=_ide(uid)))
    _refusal(await client.post(f"{API}/execute/run-as-job", headers=admin, json=_ide(uid)))
    assert prov.builds == []
    assert await _build_jobs(client, admin, uid) == []

    await _accept(client, admin, detail["spec"])
    r = await client.post(f"{API}/execute", headers=admin, json=_widget(uid))
    assert r.status_code == 200, r.text
    assert prov.builds == [uid]


async def test_accepting_an_environment_in_one_project_does_not_cover_another(client, prov):
    admin = await _admin(client)
    first = await _project(client, admin)
    ws = (await client.get(f"{API}/projects/{first}", headers=admin)).json()["workspaceId"]
    second = await _project(client, admin, ws)
    await _plant(client, admin, first)
    await _plant(client, admin, second)
    await _accept(client, admin, _refusal(await client.post(f"{API}/execute", headers=admin, json=_ide(first)))["spec"])

    assert (await client.post(f"{API}/execute", headers=admin, json=_ide(first))).status_code == 200
    _refusal(await client.post(f"{API}/execute", headers=admin, json=_ide(second)))
    assert prov.builds == [first]


async def test_a_changed_environment_asks_again(client, prov):
    admin = await _admin(client)
    uid = await _project(client, admin)
    await _plant(client, admin, uid)
    await _accept(client, admin, _refusal(await client.post(f"{API}/execute", headers=admin, json=_ide(uid)))["spec"])
    assert (await client.post(f"{API}/execute", headers=admin, json=_ide(uid))).status_code == 200

    prov.built.clear()
    await _plant(client, admin, uid, PYPROJECT.replace("innerpkg", "otherpkg"))
    _refusal(await client.post(f"{API}/execute", headers=admin, json=_ide(uid)))
    assert prov.builds == [uid]


async def test_an_ide_writer_cannot_get_code_run_through_someone_elses_run(client, db, prov):
    from app.core.security import hash_password
    from app.models.project_member import ProjectMember
    from app.models.role import Role
    from app.models.user import User

    admin = await _admin(client)
    uid = await _project(client, admin)
    await _accept(client, admin, CODE)
    db.add(User(username="writer", password_hash=hash_password("pw-for-tests-only"), role="user"))
    db.add(Role(name="ide-writer", scope="workspace", permissions=["projects:read", "ide:read", "ide:write"]))
    await db.commit()
    writer_id = next(u["id"] for u in (await client.get(f"{API}/users", headers=admin)).json() if u["username"] == "writer")
    db.add(ProjectMember(project_uid=uid, user_id=writer_id, role="ide-writer"))
    await db.commit()
    writer = await _login(client, "writer")

    await _plant(client, writer, uid)
    assert (await client.post(f"{API}/execute", headers=writer, json=_ide(uid))).status_code == 403
    assert (await client.post(f"{API}/projects/{uid}/environments/python/build", headers=writer)).status_code == 403

    _refusal(await client.post(f"{API}/execute", headers=admin, json=_widget(uid)))
    assert prov.builds == []
    assert await _build_jobs(client, admin, uid) == []


async def _wait_job(client, headers, job_id: str) -> dict:
    for _ in range(200):
        job = (await client.get(f"{API}/jobs/{job_id}", headers=headers)).json()
        if job["status"] in ("done", "error", "cancelled"):
            return job
        await asyncio.sleep(0.02)
    raise AssertionError("job did not finish")


async def test_building_or_changing_packages_oneself_counts_as_acceptance(client, prov):
    admin = await _admin(client)
    uid = await _project(client, admin)
    await _plant(client, admin, uid)

    job = (await client.post(f"{API}/projects/{uid}/environments/python/build", headers=admin)).json()
    assert (await _wait_job(client, admin, job["id"]))["status"] == "done"
    prov.built.clear()
    assert (await client.post(f"{API}/execute", headers=admin, json=_ide(uid))).status_code == 200

    r = await client.post(f"{API}/projects/{uid}/environments/python/packages", headers=admin, json={"packages": ["six"]})
    assert r.status_code == 200, r.text
    prov.built.clear()
    assert (await client.post(f"{API}/execute", headers=admin, json=_ide(uid))).status_code == 200
    assert prov.builds == [uid, uid, uid]


async def test_an_environment_with_nothing_to_build_runs_without_asking(client, prov):
    admin = await _admin(client)
    uid = await _project(client, admin)
    assert (await client.post(f"{API}/execute", headers=admin, json=_ide(uid))).status_code == 200
    assert prov.builds == []


class _Socket:
    def __init__(self, params: dict[str, str], script: list[dict]):
        self.query_params = params
        self.headers: dict[str, str] = {}
        self.script = list(script)
        self.sent: list[dict] = []
        self.closed = asyncio.Event()

    async def accept(self) -> None:
        pass

    async def close(self, code: int = 1000) -> None:
        self.closed.set()

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)
        if message["type"] in ("done", "error"):
            self.closed.set()

    async def receive_json(self) -> dict:
        if self.script:
            return self.script.pop(0)
        await asyncio.wait_for(self.closed.wait(), 30)
        raise WebSocketDisconnect()


async def test_a_terminal_never_builds_an_environment_its_user_has_not_accepted(client, prov):
    admin = await _admin(client)
    uid = await _project(client, admin)
    await _plant(client, admin, uid)
    token = admin["Authorization"].removeprefix("Bearer ")
    ws = _Socket({"token": token, "projectUid": uid, "language": "python", "sessionId": "s1"}, [{"code": "1 + 1"}])

    await execution_routes.terminal_ws(ws)

    refusals = [m for m in ws.sent if m.get("code") == "environment_acceptance_required"]
    assert refusals and refusals[0]["type"] == "error" and PYPROJECT in refusals[0]["spec"]
    assert not any(m["type"] == "done" for m in ws.sent)
    assert prov.builds == []


async def test_a_run_builds_only_the_spec_its_user_accepted(client, db, prov):
    from app.services.execution.uv_provisioner import ProvisionError

    admin = await _admin(client)
    uid = await _project(client, admin)
    await _plant(client, admin, uid)
    accepted = environments.spec_text(uid, "python")
    await _plant(client, admin, uid, PYPROJECT.replace("innerpkg", "otherpkg"))

    with pytest.raises(ProvisionError):
        await environments.build(db, uid, "python", accepted_spec=accepted)
    assert prov.builds == []
