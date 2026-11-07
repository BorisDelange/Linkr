"""A session is bound to the password state it was issued from: every session
authorized by a credential from before a password change is refused after it,
however late the token was minted."""

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.api.v1.routes import auth as auth_route
from app.models.user import User

API = "/api/v1"
PASSWORD = "pw-for-tests-only"
NEW_PASSWORD = "a-long-enough-one"


async def _setup(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": PASSWORD})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": PASSWORD})
    return r.json()


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _change(client, access: str):
    return await client.post(f"{API}/auth/change-password", headers=_bearer(access),
                             json={"currentPassword": PASSWORD, "newPassword": NEW_PASSWORD})


async def test_tokens_issued_from_a_row_read_before_a_change_are_refused_after_it(client, engine):
    tokens = await _setup(client)
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as early:
        row_read_before = await early.get(User, tokens["user"]["id"])

    changed = await _change(client, tokens["access_token"])
    assert changed.status_code == 200

    late = auth_route._issue_tokens(row_read_before)
    assert (await client.get(f"{API}/auth/me", headers=_bearer(late.access_token))).status_code == 401
    assert (await client.post(f"{API}/auth/refresh", json={"refresh_token": late.refresh_token})).status_code == 401

    fresh = changed.json()
    assert (await client.get(f"{API}/auth/me", headers=_bearer(fresh["access_token"]))).status_code == 200
    renewed = await client.post(f"{API}/auth/refresh", json={"refresh_token": fresh["refresh_token"]})
    assert renewed.status_code == 200
    assert (await client.get(f"{API}/auth/me", headers=_bearer(renewed.json()["access_token"]))).status_code == 200


async def test_a_refresh_overlapping_a_change_leaves_no_surviving_session(client):
    import asyncio

    tokens = await _setup(client)
    stolen = tokens["refresh_token"]
    minted: list[dict] = []
    stop = asyncio.Event()

    async def replay():
        while not stop.is_set():
            r = await client.post(f"{API}/auth/refresh", json={"refresh_token": stolen})
            if r.status_code == 200:
                minted.append(r.json())
            await asyncio.sleep(0)

    loops = [asyncio.create_task(replay()) for _ in range(4)]
    await asyncio.sleep(0.05)
    assert (await _change(client, tokens["access_token"])).status_code == 200
    stop.set()
    await asyncio.gather(*loops)

    assert minted
    for pair in minted:
        assert (await client.get(f"{API}/auth/me", headers=_bearer(pair["access_token"]))).status_code == 401
        assert (await client.post(f"{API}/auth/refresh", json={"refresh_token": pair["refresh_token"]})).status_code == 401


async def test_an_api_key_created_from_a_session_overlapping_a_change_is_refused(client, engine, monkeypatch):
    from app.services import api_token_service

    tokens = await _setup(client)
    create_token = api_token_service.create_token

    async def change_meanwhile(db, user, name, expires_in_days):
        assert (await _change(client, tokens["access_token"])).status_code == 200
        return await create_token(db, user, name, expires_in_days)

    monkeypatch.setattr(api_token_service, "create_token", change_meanwhile)
    r = await client.post(f"{API}/auth/api-tokens", headers=_bearer(tokens["access_token"]), json={"name": "k"})
    key = r.json().get("token") if r.status_code == 201 else None
    if key is not None:
        assert (await client.get(f"{API}/auth/me", headers=_bearer(key))).status_code == 401
    else:
        assert r.status_code == 401
