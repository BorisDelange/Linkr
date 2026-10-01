"""POST /auth/change-password (security plan B4): the dialog called a route that
did not exist. Current password required, a server-side policy, logged. A change
ends every session issued before it; the caller gets fresh tokens."""

import time

import pytest
from jose import jwt

from app.config import settings
from app.core import audit
from app.core.security import password_policy_error

API = "/api/v1"


async def _login(client, password: str = "pw-for-tests-only") -> dict:
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": password})
    return {"Authorization": f"Bearer {r.json()['access_token']}"} if r.status_code == 200 else {}


async def test_change_password_end_to_end(client):
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    h = await _login(client)
    change = lambda cur, new: client.post(f"{API}/auth/change-password", headers=h,  # noqa: E731
                                          json={"currentPassword": cur, "newPassword": new})

    assert (await change("wrong", "a-long-enough-one")).status_code == 403
    assert (await change("pw-for-tests-only", "short")).status_code == 422
    assert (await change("pw-for-tests-only", "admin")).status_code == 422
    assert (await change("pw-for-tests-only", "a-long-enough-one")).status_code == 200

    assert await _login(client, "pw-for-tests-only") == {}
    assert await _login(client, "a-long-enough-one")
    actions = [r["action"] for r in audit.query(filters={"action": ["password_change", "password_change_failed"]})[0]]
    assert sorted(actions) == ["password_change", "password_change_failed"]


async def test_an_api_token_cannot_change_the_password(client):
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    h = await _login(client)
    key = (await client.post(f"{API}/auth/api-tokens", headers=h, json={"name": "k"})).json()["token"]
    r = await client.post(f"{API}/auth/change-password", headers={"Authorization": f"Bearer {key}"},
                          json={"currentPassword": "pw-for-tests-only", "newPassword": "a-long-enough-one"})
    assert r.status_code == 401


@pytest.mark.parametrize("password, ok", [
    ("x" * 11, False), ("x" * 12, True), ("Alice.Martin", False), (" alice.martin ", False), ("alice.martin!", True),
])
def test_policy(password, ok):
    assert (password_policy_error(password, "alice.martin") is None) is ok


def _earlier_token(user_id: int, kind: str) -> str:
    """A session token issued a while ago — `iat` has whole-second resolution, so
    one minted in the test's own second would count as issued with the change."""
    now = int(time.time())
    payload = {"sub": str(user_id), "username": "admin", "role": "admin", "type": kind,
               "iat": now - 10, "exp": now + 3600}
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


async def _admin_id(client) -> int:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    h = await _login(client)
    return (await client.get(f"{API}/auth/me", headers=h)).json()["id"]


async def test_a_change_ends_the_sessions_issued_before_it(client):
    admin_id = await _admin_id(client)
    stolen = {"Authorization": f"Bearer {_earlier_token(admin_id, 'access')}"}
    stolen_refresh = _earlier_token(admin_id, "refresh")
    assert (await client.get(f"{API}/auth/me", headers=stolen)).status_code == 200

    r = await client.post(f"{API}/auth/change-password", headers=await _login(client),
                          json={"currentPassword": "pw-for-tests-only", "newPassword": "a-long-enough-one"})
    fresh = r.json()

    assert (await client.get(f"{API}/auth/me", headers=stolen)).status_code == 401
    assert (await client.post(f"{API}/auth/refresh", json={"refresh_token": stolen_refresh})).status_code == 401
    me = await client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {fresh['access_token']}"})
    assert me.status_code == 200
    assert (await client.post(f"{API}/auth/refresh", json={"refresh_token": fresh["refresh_token"]})).status_code == 200


async def test_an_admin_reset_ends_the_users_sessions(client):
    await _admin_id(client)
    h = await _login(client)
    bob = (await client.post(f"{API}/users", headers=h, json={"username": "bob", "password": "bob-first-password"})).json()
    stolen = {"Authorization": f"Bearer {_earlier_token(bob['id'], 'access')}"}
    assert (await client.get(f"{API}/auth/me", headers=stolen)).status_code == 200
    r = await client.patch(f"{API}/users/{bob['id']}", headers=h, json={"password": "bob-second-password"})
    assert r.status_code == 200
    assert (await client.get(f"{API}/auth/me", headers=stolen)).status_code == 401


async def test_setup_and_user_admin_apply_the_policy(client):
    r = await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "short"})
    assert r.status_code == 422
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw-for-tests-only"})
    h = await _login(client)
    assert (await client.post(f"{API}/users", headers=h, json={"username": "bob", "password": "pw"})).status_code == 422
    assert (await client.post(f"{API}/users", headers=h, json={"username": "bob", "password": "bob"})).status_code == 422
    bob = (await client.post(f"{API}/users", headers=h, json={"username": "bob", "password": "bob-first-password"})).json()
    assert (await client.patch(f"{API}/users/{bob['id']}", headers=h, json={"password": "short"})).status_code == 422
    r = await client.patch(f"{API}/users/{bob['id']}", headers=h,
                           json={"username": "bob-first-password", "password": "bob-first-password"})
    assert r.status_code == 422
