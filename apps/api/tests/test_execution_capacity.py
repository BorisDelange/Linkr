"""Server-side runs share the instance with every other user.

A run holds no database connection while it queues or runs, so a burst of renders
cannot starve other requests of the pool, and one user's runs take no more than a
share of the ephemeral slots, so another user's widget still finds one free.
"""

import asyncio

import pytest

from app.config import settings
from app.services import project_fs
from app.services.execution import kernel as kernel_module
from app.services.execution import runtime
from app.services.execution.render import correlation_matrix

API = "/api/v1"


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _project_with_dataset(client, headers) -> str:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "W"}})).json()["id"]
    uid = (await client.post(f"{API}/projects", headers=headers, json={"name": {"en": "P"}, "workspaceId": ws})).json()["uid"]
    (project_fs.datasets_dir(uid) / "d.csv").write_text("age\n1\n2\n3\n")
    return uid


@pytest.fixture
def connections_during_run(monkeypatch, engine) -> list[int]:
    seen: list[int] = []
    output = runtime.RuntimeOutput(stdout="{}", stderr="", figures=[], table=None, html=None)

    async def run_ephemeral(language, project_uid, code, environment=None, resolver=None):
        seen.append(engine.sync_engine.pool.checkedout())
        return output

    class FakeKernel:
        async def execute(self, code, query_resolver=None):
            seen.append(engine.sync_engine.pool.checkedout())
            return output

    async def get_kernel(*args, **kwargs):
        return FakeKernel()

    monkeypatch.setattr(kernel_module, "run_ephemeral", run_ephemeral)
    monkeypatch.setattr(kernel_module.manager, "get", get_kernel)
    return seen


async def test_a_render_holds_no_database_connection_while_it_runs(client, connections_during_run):
    admin = await _admin(client)
    uid = await _project_with_dataset(client, admin)
    r = await client.post(f"{API}/execute/render", headers=admin, json={
        "kind": "correlation-matrix", "spec": {"names": ["age"], "method": "pearson"},
        "projectUid": uid, "datasetFileId": "d.csv",
    })
    assert r.status_code == 200, r.text
    assert connections_during_run == [0]


@pytest.mark.parametrize("ephemeral", [True, False])
async def test_a_code_run_holds_no_database_connection_while_it_runs(client, connections_during_run, ephemeral):
    admin = await _admin(client)
    uid = await _project_with_dataset(client, admin)
    r = await client.post(f"{API}/execute", headers=admin, json={
        "language": "python", "code": "1 + 1", "projectUid": uid, "purpose": "ide", "ephemeral": ephemeral,
    })
    assert r.status_code == 200, r.text
    assert connections_during_run == [0]


async def test_one_users_runs_leave_another_user_a_slot(monkeypatch):
    monkeypatch.setattr(settings, "widget_max_concurrency", 4)
    monkeypatch.setattr(kernel_module, "_ephemeral_gate", kernel_module.EphemeralConcurrency())
    shares = kernel_module.EphemeralShares()
    release = asyncio.Event()
    running: list[int] = []

    async def run(user_id: int) -> None:
        async with shares.slot(user_id), kernel_module._ephemeral_gate:
            running.append(user_id)
            await release.wait()

    first_user = [asyncio.create_task(run(1)) for _ in range(6)]
    await asyncio.sleep(0.01)
    assert running.count(1) < 4

    other = asyncio.create_task(run(2))
    await asyncio.sleep(0.01)
    assert 2 in running

    release.set()
    await asyncio.gather(*first_user, other)
    assert running.count(1) == 6


async def test_a_user_queueing_too_many_runs_is_turned_away(monkeypatch):
    monkeypatch.setattr(kernel_module.EphemeralShares, "QUEUE_PER_USER", 3)
    shares = kernel_module.EphemeralShares()
    release = asyncio.Event()

    async def run(user_id: int) -> None:
        async with shares.slot(user_id):
            await release.wait()

    held = [asyncio.create_task(run(1)) for _ in range(3)]
    await asyncio.sleep(0.01)
    with pytest.raises(kernel_module.EphemeralBusy):
        async with shares.slot(1):
            pass
    async with shares.slot(2):
        pass
    release.set()
    await asyncio.gather(*held)
    async with shares.slot(1):
        pass


def test_a_correlation_matrix_counts_each_column_once():
    spec = correlation_matrix.validate_spec({"names": ["age"] * 400 + ["bmi", "age"], "method": "pearson"})
    assert spec["names"] == ["age", "bmi"]
