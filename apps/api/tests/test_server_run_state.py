"""A server run's row: one going on per kind and scope, claimed by one executor whose
writes a takeover fences off, paused through what the page asks."""

import pytest
from sqlalchemy import update

from app.models.server_run import ServerRun
from app.services.server_runs import state

API = "/api/v1"


async def _source(client) -> tuple[str, str]:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    admin = {"Authorization": f"Bearer {r.json()['access_token']}"}
    ws = (await client.post(f"{API}/workspaces", headers=admin, json={"name": {"en": "WS"}})).json()["id"]
    ds = (await client.post(f"{API}/data-sources", headers=admin, json={
        "workspaceId": ws, "alias": "db", "name": "DB", "sourceType": "database",
        "connectionConfig": {"engine": "postgresql", "host": "h", "database": "omop"},
    })).json()["id"]
    return ws, ds


async def _create(db, ws, ds, scope=None):
    return await state.create(
        db, kind="stats", scope_id=scope or ds, data_source_id=ds, workspace_id=ws, user_id=1,
        spec={"counts": None}, initial={"stage": "ranking"},
    )


async def test_a_second_start_gets_the_run_going_on(client, db):
    ws, ds = await _source(client)
    first, created = await _create(db, ws, ds)
    second, again = await _create(db, ws, ds)
    assert created and not again
    assert second.id == first.id
    # Another scope is another run.
    other, created_other = await _create(db, ws, ds, scope="project-1")
    assert created_other and other.id != first.id


async def test_an_ended_run_leaves_room_for_the_next(client, db):
    ws, ds = await _source(client)
    first, _ = await _create(db, ws, ds)
    await state.ask(db, first, "pause")
    assert first.status == "paused"
    second, created = await _create(db, ws, ds)
    assert created and second.id != first.id
    assert (await state.latest(db, "stats", ds)).id == second.id


async def test_one_executor_claims_it_and_a_stale_one_writes_nothing(client, db):
    ws, ds = await _source(client)
    run, _ = await _create(db, ws, ds)
    attempt = await state.claim(db, run.id)
    assert attempt == 1
    assert await state.claim(db, run.id) is None
    await state.write(db, run.id, attempt, state={"done": 1})

    # Taken over (a resume after a restart): the first executor is fenced off.
    await db.execute(update(ServerRun).where(ServerRun.id == run.id).values(status="queued"))
    await db.commit()
    assert await state.claim(db, run.id) == 2
    with pytest.raises(state.Fenced):
        await state.write(db, run.id, attempt, state={"done": 99})
    await db.refresh(run)
    assert run.state == {"done": 1}


async def test_a_pause_stops_a_queued_run_and_asks_a_running_one(client, db):
    ws, ds = await _source(client)
    queued, _ = await _create(db, ws, ds)
    await state.ask(db, queued, "cancel")
    assert queued.status == "cancelled" and queued.finished_at is not None

    running, _ = await _create(db, ws, ds)
    await state.claim(db, running.id)
    await db.refresh(running)
    await state.ask(db, running, "pause")
    assert running.status == "pausing"
    assert await state.requested(db, running.id) == "pause"


async def test_runs_of_an_earlier_process_are_orphans(client, db):
    ws, ds = await _source(client)
    run, _ = await _create(db, ws, ds)
    await state.claim(db, run.id)
    assert await state.orphans(db) == []
    await db.execute(update(ServerRun).where(ServerRun.id == run.id).values(boot_id="an-earlier-boot"))
    await db.commit()
    assert [r.id for r in await state.orphans(db)] == [run.id]


async def test_a_paused_run_is_queued_again_where_it_stopped(client, db):
    ws, ds = await _source(client)
    run, _ = await _create(db, ws, ds)
    attempt = await state.claim(db, run.id)
    await state.write(db, run.id, attempt, status="paused", state={"stage": "batches", "done": 500})
    await db.refresh(run)
    run = await state.requeue(db, run, user_id=1)
    assert run.status == "queued" and run.state["done"] == 500
    assert await state.claim(db, run.id) == attempt + 1
