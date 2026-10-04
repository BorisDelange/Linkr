"""POST /auth/change-password (security plan B4): the dialog called a route that
did not exist. Current password required, a server-side policy, logged. A change
ends every session issued before it; the caller gets fresh tokens."""

import time
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from jose import jwt

from app.config import settings
from app.core import audit
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    password_policy_error,
    predates_password_change,
    set_password,
)

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
    same = await change("pw-for-tests-only", "pw-for-tests-only")
    assert same.json()["detail"]["code"] == "password_same_as_current"
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


@pytest.mark.parametrize("password, code", [
    ("k7#mQ2!vR9p", "password_too_short"), ("k7#mQ2!vR9pL", None),
    ("x" * 72, None), ("x" * 73, "password_too_long"), ("é" * 37, "password_too_long"),
    ("Alice.Martin", "password_is_username"), (" alice.martin ", "password_is_username"), ("alice.martin!", None),
    ("Password1234", "password_common"), ("qwertyuiop123", "password_common"),
])
def test_policy(password, code):
    error = password_policy_error(password, "alice.martin")
    assert (error and error["code"]) == code


def test_the_minimum_length_is_configurable(monkeypatch):
    monkeypatch.setattr(settings, "password_min_length", 16)
    assert password_policy_error("x" * 15, "bob") == {
        "code": "password_too_short", "minLength": 16, "message": "The password must be at least 16 characters.",
    }
    assert password_policy_error("x" * 16, "bob") is None


async def test_the_status_states_the_minimum_length(client, monkeypatch):
    monkeypatch.setattr(settings, "password_min_length", 14)
    assert (await client.get(f"{API}/setup/status")).json()["password_min_length"] == 14


def _earlier_token(user_id: int, kind: str) -> str:
    """A session token issued a while ago, without `iat_us` (as minted before it existed)."""
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


def test_a_token_from_the_same_second_but_before_the_change_is_stale():
    changed = datetime(2026, 10, 4, 12, 0, 0, 500_000, tzinfo=timezone.utc)
    user = SimpleNamespace(password_changed_at=changed)
    same_second = int(changed.timestamp())
    before = {"iat": same_second, "iat_us": same_second * 1_000_000 + 499_999}
    after = {"iat": same_second, "iat_us": same_second * 1_000_000 + 500_000}
    assert predates_password_change(before, user)
    assert not predates_password_change(after, user)
    assert not predates_password_change({"iat": same_second}, user)
    assert predates_password_change({"iat": same_second - 1}, user)


def test_the_tokens_minted_after_a_change_are_current():
    user = SimpleNamespace(password_changed_at=None)
    set_password(user, "a-long-enough-one")
    for token in (create_access_token(1, "admin", "admin"), create_refresh_token(1, "admin", "admin")):
        assert not predates_password_change(decode_token(token), user)


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
