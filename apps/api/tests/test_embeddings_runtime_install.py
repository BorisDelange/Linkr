"""The embeddings runtime is one per instance: installing it is an instance-level
action, never done under a running worker, and a failed install keeps the old one."""

import json

import pytest

from app.core.security import hash_password
from app.models.user import User
from app.models.workspace_member import WorkspaceMember
from app.services.suggestions import runtime, tasks
from tests.test_ide_files import _admin_headers

API = "/api/v1"


class _Handle:
    async def log(self, line): ...
    async def progress(self, value): ...
    async def set_result(self, value): ...


@pytest.fixture
def fake_build(monkeypatch):
    """A build that creates a venv's interpreter wherever uv is told to."""
    state = {"fail": False, "steps": []}

    async def stream(args, env, on_line):
        state["steps"].append(args)
        if state["fail"]:
            return 1
        if args[1] == "venv":
            from pathlib import Path

            (Path(args[-1]) / "bin").mkdir(parents=True)
            (Path(args[-1]) / "bin" / "python").write_text("new")
        return 0

    async def worker(command, spec, **kwargs):
        return {"torch": "fake", "python": str(kwargs.get("python"))}

    monkeypatch.setattr(runtime, "_stream", stream)
    monkeypatch.setattr(runtime, "run_worker", worker)
    return state


def _installed(marker: str = "old") -> None:
    runtime.venv_python().parent.mkdir(parents=True)
    runtime.venv_python().write_text(marker)
    runtime._probe_path().write_text(json.dumps({"torch": marker}))


async def test_an_install_ends_with_the_new_runtime_in_place(fake_build):
    _installed()
    await runtime.install(_Handle())
    assert runtime.venv_python().read_text() == "new"
    assert runtime.is_installed()
    assert sorted(p.name for p in runtime.runtime_dir().parent.iterdir()) == ["embeddings"]


async def test_a_failed_install_keeps_the_runtime_in_use(fake_build):
    _installed()
    fake_build["fail"] = True
    with pytest.raises(runtime.WorkerError):
        await runtime.install(_Handle())
    assert runtime.venv_python().read_text() == "old"
    assert runtime.is_installed()
    assert sorted(p.name for p in runtime.runtime_dir().parent.iterdir()) == ["embeddings"]


async def test_an_install_never_replaces_the_runtime_under_a_running_worker(fake_build):
    _installed()
    with runtime.worker_running(), pytest.raises(runtime.RuntimeInUse):
        await runtime.install(_Handle())
    assert runtime.venv_python().read_text() == "old"


async def test_a_worker_counts_as_running_only_while_it_runs(monkeypatch):
    seen = []

    async def stream(args, env, on_line):
        seen.append(runtime.in_use())
        await on_line('@@result {"ok": 1}')
        return 0

    monkeypatch.setattr(runtime, "_stream", stream)
    assert await runtime.run_worker("probe", {}, python=runtime.venv_python()) == {"ok": 1}
    assert seen == [True] and not runtime.in_use()


async def _editor_of(client, db, admin) -> tuple[str, dict]:
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "W"}})).json()["id"]
    user = User(username="editor", password_hash=hash_password("pw-for-tests-only"), role="user")
    db.add(user)
    await db.flush()
    db.add(WorkspaceMember(workspace_id=ws, user_id=user.id, role="editor"))
    await db.commit()
    r = await client.post(f"{API}/auth/login", json={"username": "editor", "password": "pw-for-tests-only"})
    return ws, {"Authorization": f"Bearer {r.json()['access_token']}"}


async def test_a_workspace_permission_does_not_install_the_shared_runtime(client, db, seed_roles, fake_build):
    admin = await _admin_headers(client)
    ws, editor = await _editor_of(client, db, admin)
    _installed()

    r = await client.post(f"{API}/workspaces/{ws}/suggestion-engines/runtime/install", headers=editor)

    assert r.status_code == 403
    assert fake_build["steps"] == [] and runtime.venv_python().read_text() == "old"


async def test_an_administrator_installs_it_unless_a_worker_is_running(client, db, seed_roles, fake_build):
    admin = await _admin_headers(client)
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "W"}})).json()["id"]
    url = f"{API}/workspaces/{ws}/suggestion-engines/runtime/install"

    with runtime.worker_running():
        assert (await client.post(url, headers=admin)).status_code == 409

    assert (await client.post(url, headers=admin)).status_code == 200


async def test_the_default_setup_leaves_a_missing_runtime_to_an_administrator(client, db, seed_roles, monkeypatch):
    admin = await _admin_headers(client)
    ws, editor = await _editor_of(client, db, admin)
    launched = []

    async def fake_setup(handle, workspace_id):
        launched.append(workspace_id)

    monkeypatch.setattr(tasks, "setup_default", fake_setup)
    url = f"{API}/workspaces/{ws}/suggestion-engines/setup-default"

    assert (await client.post(url, headers=editor)).status_code == 403

    _installed()
    assert (await client.post(url, headers=editor)).status_code == 200


