import asyncio

from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings
from app.core import setup_token
from app.core.database import Base, get_db
from app.core.security import set_password_async
from app.main import app
from app.models.user import User

API = "/api/v1"


async def test_setup_status_and_initialize(client):
    r = await client.get(f"{API}/setup/status")
    assert r.status_code == 200
    assert r.json() == {"needs_setup": True, "setup_token_required": False, "trusted_header_login": False, "export_min_count": 11, "password_min_length": 12}

    r = await client.post(
        f"{API}/setup/initialize",
        json={"username": "admin", "password": "pw-for-tests-only", "email": "a@b.c"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["username"] == "admin"
    assert body["role"] == "admin"

    r = await client.get(f"{API}/setup/status")
    assert r.json() == {"needs_setup": False, "setup_token_required": False, "trusted_header_login": False, "export_min_count": 11, "password_min_length": 12}

    # Second initialize is rejected once a user exists.
    r = await client.post(
        f"{API}/setup/initialize", json={"username": "x", "password": "y"}
    )
    assert r.status_code == 400


async def test_the_first_admin_needs_the_token_of_this_boot(client, monkeypatch):
    monkeypatch.setattr(settings, "setup_token", "")
    monkeypatch.setattr(setup_token, "_token", None)
    assert setup_token.arm() is True
    token = setup_token.current()
    assert len(token) >= 32
    assert (await client.get(f"{API}/setup/status")).json()["setup_token_required"] is True

    account = {"username": "admin", "password": "pw-for-tests-only"}
    for wrong in ({}, {"setup_token": ""}, {"setup_token": "guess"}, {"setup_token": "é"}):
        r = await client.post(f"{API}/setup/initialize", json={**account, **wrong})
        assert r.status_code == 403, wrong
        assert r.json()["detail"]["code"] == "setup_token_invalid"
    assert (await client.get(f"{API}/setup/status")).json()["needs_setup"] is True

    assert (await client.post(f"{API}/setup/initialize", json={**account, "setup_token": token})).status_code == 200
    status = (await client.get(f"{API}/setup/status")).json()
    assert status["needs_setup"] is False
    assert status["setup_token_required"] is False


async def test_a_configured_token_is_used_and_not_shown(client, monkeypatch):
    monkeypatch.setattr(settings, "setup_token", "chosen-by-the-operator")
    monkeypatch.setattr(setup_token, "_token", None)
    assert setup_token.arm() is False
    r = await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only", "setup_token": "chosen-by-the-operator"})
    assert r.status_code == 200


async def test_login_me_refresh(client):
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"}
    )

    r = await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "pw-for-tests-only"}
    )
    assert r.status_code == 200
    tokens = r.json()
    assert tokens["token_type"] == "bearer"
    assert tokens["user"]["username"] == "admin"

    headers = {"Authorization": f"Bearer {tokens['access_token']}"}
    r = await client.get(f"{API}/auth/me", headers=headers)
    assert r.status_code == 200
    me = r.json()
    assert me["username"] == "admin"
    # /me exposes the global-tier permissions for UI gating; admin gets them all.
    assert "app-database:read" in me["permissions"]
    assert "users:read" in me["permissions"]

    r = await client.post(
        f"{API}/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    assert r.status_code == 200
    assert r.json()["access_token"]


async def test_login_bad_password(client):
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"}
    )
    r = await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "wrong"}
    )
    assert r.status_code == 401


async def test_me_requires_token(client):
    r = await client.get(f"{API}/auth/me")
    assert r.status_code == 401  # HTTPBearer rejects missing credentials


async def test_concurrent_initialize_creates_one_admin(tmp_path, monkeypatch):
    """Hashing takes as long as it does in production, not the tests' cheap rounds."""
    async def _slow_hash(user, password):
        await asyncio.sleep(0.2)
        await set_password_async(user, password)

    monkeypatch.setattr("app.api.v1.routes.setup.set_password_async", _slow_hash)
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/setup.db")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def _get_db():
        async with maker() as session:
            yield session

    app.dependency_overrides[get_db] = _get_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            results = await asyncio.gather(
                *(
                    client.post(f"{API}/setup/initialize", json={"username": f"admin{i}", "password": "pw-for-tests-only"})
                    for i in range(4)
                )
            )
        async with maker() as session:
            admins = await session.scalar(select(func.count(User.id)))
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
    assert sorted(r.status_code for r in results) == [200, 400, 400, 400]
    assert admins == 1
