"""A query its user waits for stops at the time limit, freeing what it held; an
administrator can stop anyone's job; other users only their own."""

import asyncio

import duckdb
import pytest
from sqlalchemy import select

from app.config import settings
from app.core.security import hash_password
from app.models.user import User
from app.services.data import managed_db, query_cancel
from app.services.execution import jobs

API = "/api/v1"
ENDLESS = "SELECT count(*) AS n FROM range(100000000000) a"


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _member(db, client, admin, ws: str, username: str) -> dict:
    db.add(User(username=username, password_hash=hash_password("pw-for-tests-only"), role="user"))
    await db.commit()
    user_id = (await db.execute(select(User.id).where(User.username == username))).scalar_one()
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin, json={"userId": user_id, "role": "editor"})
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw-for-tests-only"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _database(client, headers) -> tuple[str, str]:
    ws = (await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}})).json()["id"]
    ds = (await client.post(f"{API}/data-sources", headers=headers, json={
        "workspaceId": ws, "alias": "d", "name": {"en": "Demo"}, "sourceType": "database",
        "connectionConfig": {"engine": "duckdb", "managed": True},
    })).json()["id"]
    r = await client.post(f"{API}/data-sources/{ds}/create-from-ddl", headers=headers, json={"ddl": "CREATE TABLE t (a INT);"})
    assert r.status_code == 200, r.text
    con = duckdb.connect(str(managed_db.path_for(ds)))
    con.execute("INSERT INTO t SELECT i FROM range(3) r(i)")
    con.close()
    return ws, ds


async def _queries(client, headers, ws) -> list[dict]:
    await asyncio.gather(*list(jobs._status_writes), return_exceptions=True)
    return [j for j in (await client.get(f"{API}/workspaces/{ws}/jobs", headers=headers)).json() if j["kind"] == "sql_query"]


async def _running(client, headers, ws, label: str) -> dict:
    for _ in range(300):
        running = [j for j in await _queries(client, headers, ws) if j["label"] == label and j["status"] == "running"]
        if running:
            return running[0]
        await asyncio.sleep(0.02)
    raise AssertionError(f"{label} never ran")


# --- within_limit ---------------------------------------------------------------


async def test_work_past_the_limit_is_stopped_and_reported(monkeypatch):
    monkeypatch.setattr(settings, "query_timeout_seconds", 1)
    stopped: list[tuple] = []
    interrupt = asyncio.Event()

    def cancel(query_id: str, owner: str) -> None:
        stopped.append((query_id, owner))
        interrupt.set()

    monkeypatch.setattr(query_cancel, "cancel", cancel)

    with pytest.raises(query_cancel.TimedOut, match="1-second limit"):
        await query_cancel.within_limit(interrupt.wait, "7", "q1")
    assert stopped == [("q1", "7")]


async def test_a_limit_of_zero_lets_work_run_its_course(monkeypatch):
    monkeypatch.setattr(settings, "query_timeout_seconds", 0)

    async def slow() -> str:
        await asyncio.sleep(0.2)
        return query_cancel.current_query.get()[1]

    assert await query_cancel.within_limit(slow, "7") == "7"


# --- /query ------------------------------------------------------------------------


async def test_a_query_past_the_limit_is_stopped_and_frees_its_slot(client, monkeypatch):
    monkeypatch.setattr(settings, "query_timeout_seconds", 1)
    headers = await _admin(client)
    ws, ds = await _database(client, headers)

    r = await asyncio.wait_for(client.post(f"{API}/data-sources/{ds}/query", headers=headers, json={
        "sql": ENDLESS, "origin": "endless", "heavy": True,
    }), 30)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "query_time_limit"
    [job] = [j for j in await _queries(client, headers, ws) if j["label"] == "endless"]
    assert job["status"] == "error"
    assert "limit" in (await client.get(f"{API}/jobs/{job['id']}", headers=headers)).json()["logTail"]

    # The one heavy slot and the database's connection are free again.
    r = await asyncio.wait_for(client.post(f"{API}/data-sources/{ds}/query", headers=headers, json={
        "sql": "SELECT a FROM t", "heavy": True,
    }), 30)
    assert r.status_code == 200 and len(r.json()["rows"]) == 3


async def test_a_query_within_the_limit_answers_as_usual(client, monkeypatch):
    monkeypatch.setattr(settings, "query_timeout_seconds", 60)
    headers = await _admin(client)
    _, ds = await _database(client, headers)
    r = await client.post(f"{API}/data-sources/{ds}/query", headers=headers, json={"sql": "SELECT a FROM t"})
    assert r.status_code == 200 and len(r.json()["rows"]) == 3


async def test_an_admin_stops_another_users_running_query(client, db):
    admin = await _admin(client)
    ws, ds = await _database(client, admin)
    bob = await _member(db, client, admin, ws, "bob")
    request = asyncio.create_task(client.post(f"{API}/data-sources/{ds}/query", headers=bob, json={
        "sql": ENDLESS, "origin": "bob's",
    }))
    job = await _running(client, bob, ws, "bob's")

    listed = (await client.get(f"{API}/jobs/running", headers=admin)).json()
    mine = next(j for j in listed if j["id"] == job["id"])
    assert mine["username"] == "bob" and mine["cancellable"] is True and mine["input"] is None

    assert (await client.post(f"{API}/jobs/{job['id']}/cancel", headers=admin)).status_code == 204
    r = await asyncio.wait_for(request, 30)
    assert r.status_code == 409
    [ended] = [j for j in await _queries(client, bob, ws) if j["label"] == "bob's"]
    assert ended["status"] == "cancelled"
    r = await asyncio.wait_for(client.post(f"{API}/data-sources/{ds}/query", headers=bob, json={"sql": "SELECT a FROM t"}), 30)
    assert r.status_code == 200


async def test_only_an_admin_or_the_owner_stops_a_job(client, db, monkeypatch):
    from app.core import audit

    lines: list[dict] = []
    monkeypatch.setattr(audit, "write", lambda ctx: lines.append(dict(ctx)))
    admin = await _admin(client)
    ws, ds = await _database(client, admin)
    bob = await _member(db, client, admin, ws, "bob")
    eve = await _member(db, client, admin, ws, "eve")

    request = asyncio.create_task(client.post(f"{API}/data-sources/{ds}/query", headers=bob, json={
        "sql": ENDLESS, "origin": "bob's",
    }))
    job = await _running(client, bob, ws, "bob's")
    assert (await client.get(f"{API}/jobs/running", headers=eve)).status_code == 403
    assert (await client.post(f"{API}/jobs/{job['id']}/cancel", headers=eve)).status_code == 404
    assert job["id"] in {j["id"] for j in await _queries(client, bob, ws) if j["status"] == "running"}

    assert (await client.post(f"{API}/jobs/{job['id']}/cancel", headers=bob)).status_code == 204
    assert (await asyncio.wait_for(request, 30)).status_code == 409

    request = asyncio.create_task(client.post(f"{API}/data-sources/{ds}/query", headers=bob, json={
        "sql": ENDLESS, "origin": "bob's again",
    }))
    job = await _running(client, bob, ws, "bob's again")
    assert (await client.post(f"{API}/jobs/{job['id']}/cancel", headers=admin)).status_code == 204
    assert (await asyncio.wait_for(request, 30)).status_code == 409
    [line] = [x for x in lines if x.get("action") == "job_cancel" and job["id"] in x.get("detail", "")]
    assert line["username"] == "admin" and line["workspace_id"] == ws
