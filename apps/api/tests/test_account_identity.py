"""An account's sessions, logins and caches belong to that account alone: none of
them ever reaches another account, whatever id it is given."""

import asyncio
import threading
from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from app.core import security
from app.core.security import create_access_token, create_kernel_token, create_refresh_token
from app.models.data_source import DataSource
from app.models.stats_cache import StatsCache
from app.models.user import User
from app.services import database_credential_service as creds
from app.services import notification_hub
from app.services.data import connection_pool

API = "/api/v1"
PASSWORD = "pw-for-tests-only"


@pytest.fixture(autouse=True)
def _no_session_logins():
    yield
    with creds._session_lock:
        creds._session.clear()


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": PASSWORD})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": PASSWORD})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _create(client, admin: dict, username: str, role: str = "user") -> int:
    r = await client.post(f"{API}/users", headers=admin, json={"username": username, "password": PASSWORD, "role": role})
    assert r.status_code == 201
    return r.json()["id"]


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def test_a_deleted_users_tokens_never_authenticate_the_next_account(client):
    admin = await _admin(client)
    leaver_id = await _create(client, admin, "leaver")
    tokens = (await client.post(f"{API}/auth/login", json={"username": "leaver", "password": PASSWORD})).json()
    kernel = create_kernel_token(leaver_id, "leaver", "user", "p1", via="web")

    assert (await client.delete(f"{API}/users/{leaver_id}", headers=admin)).status_code == 204
    newcomer_id = await _create(client, admin, "newcomer", role="admin")

    assert newcomer_id != leaver_id
    assert (await client.get(f"{API}/auth/me", headers=_bearer(tokens["access_token"]))).status_code == 401
    r = await client.post(f"{API}/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert r.status_code == 401
    r = await client.get(f"{API}/projects/p1/client/databases", headers=_bearer(kernel))
    assert r.status_code == 401


async def test_an_account_refuses_session_tokens_older_than_itself(client):
    admin = await _admin(client)
    next_id = (await client.get(f"{API}/auth/me", headers=admin)).json()["id"] + 1
    early_access = create_access_token(next_id, "late", "user")
    early_refresh = create_refresh_token(next_id, "late", "user")

    assert await _create(client, admin, "late") == next_id

    assert (await client.get(f"{API}/auth/me", headers=_bearer(early_access))).status_code == 401
    r = await client.post(f"{API}/auth/refresh", json={"refresh_token": early_refresh})
    assert r.status_code == 401
    r = await client.post(f"{API}/auth/login", json={"username": "late", "password": PASSWORD})
    assert (await client.get(f"{API}/auth/me", headers=_bearer(r.json()["access_token"]))).status_code == 200


async def test_deleting_a_user_drops_their_logins_connections_and_caches(client, db):
    admin = await _admin(client)
    gone_id = await _create(client, admin, "gone")
    kept_id = await _create(client, admin, "kept")
    source = DataSource(
        alias="pg", name={"en": "PG"}, source_type="database", require_session_only=True,
        connection_config={"engine": "postgresql", "host": "h", "port": 5432, "database": "omop"},
    )
    db.add(source)
    await db.commit()
    await creds.save(db, source, gone_id, "gone_db", "pw-g", remember=False)
    await creds.save(db, source, kept_id, "kept_db", "pw-k", remember=False)
    for user_id in (gone_id, kept_id):
        db.add(StatsCache(
            scope="database", cache_key=f"{source.id}:user:{user_id}", computed_at=datetime.now(timezone.utc), payload={},
        ))
    await db.commit()
    closed: list[str] = []
    for key in (f"{source.id}:user:{gone_id}", f"{source.id}:user:{gone_id}:write", f"{source.id}:user:{kept_id}"):
        connection_pool._registry[key] = connection_pool._Entry(key)
    queue = notification_hub.subscribe(gone_id)
    notification_hub.set_context(gone_id, {"page": "x"})

    original_close = connection_pool._close_quietly
    connection_pool._close_quietly = closed.append
    try:
        assert (await client.delete(f"{API}/users/{gone_id}", headers=admin)).status_code == 204
    finally:
        connection_pool._close_quietly = original_close
        connection_pool._registry.pop(f"{source.id}:user:{kept_id}", None)

    assert not any(k[0] == gone_id for k in creds._session)
    assert (await creds.resolve_login(db, source, kept_id)).username == "kept_db"
    assert sorted(closed) == sorted([f"{source.id}:user:{gone_id}", f"{source.id}:user:{gone_id}:write"])
    keys = (await db.execute(select(StatsCache.cache_key))).scalars().all()
    assert keys == [f"{source.id}:user:{kept_id}"]
    assert queue.get_nowait() is notification_hub.CLOSE
    assert notification_hub.get_context(gone_id) is None


async def test_password_checks_run_off_the_event_loop_and_cost_the_same_for_unknown_users(client, monkeypatch):
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": PASSWORD})
    calls: list[str] = []
    original = security.pwd_context.verify

    def recording_verify(*args, **kwargs):
        calls.append(threading.current_thread().name)
        return original(*args, **kwargs)

    monkeypatch.setattr(security.pwd_context, "verify", recording_verify)
    for username in ("admin", "nobody"):
        r = await client.post(f"{API}/auth/login", json={"username": username, "password": "wrong-password"})
        assert r.status_code == 401

    assert len(calls) == 2
    assert all(name.startswith("password-hash") for name in calls)


async def test_a_burst_of_logins_leaves_the_event_loop_responsive(client, monkeypatch):
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": PASSWORD})
    original = security.pwd_context.verify

    def slow_verify(*args, **kwargs):
        threading.Event().wait(0.2)
        return original(*args, **kwargs)

    monkeypatch.setattr(security.pwd_context, "verify", slow_verify)
    logins = [
        asyncio.create_task(client.post(f"{API}/auth/login", json={"username": "admin", "password": f"x{i}"}))
        for i in range(4)
    ]
    loop = asyncio.get_running_loop()
    worst = 0.0
    while not all(t.done() for t in logins):
        before = loop.time()
        await asyncio.sleep(0.01)
        worst = max(worst, loop.time() - before)
    assert all(t.result().status_code == 401 for t in logins)
    assert worst < 0.15


async def test_a_new_account_is_stamped_at_creation(db):
    user = User(username="fresh", role="user")
    await security.set_password_async(user, PASSWORD)
    assert user.password_changed_at is not None
    assert security.verify_password(PASSWORD, user.password_hash)
