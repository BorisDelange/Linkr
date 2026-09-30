"""POST /auth/change-password (security plan B4): the dialog called a route that
did not exist. Current password required, a server-side policy, logged."""

import pytest

from app.core import audit
from app.core.security import password_policy_error

API = "/api/v1"


async def _login(client, password: str = "pw") -> dict:
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": password})
    return {"Authorization": f"Bearer {r.json()['access_token']}"} if r.status_code == 200 else {}


async def test_change_password_end_to_end(client):
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    h = await _login(client)
    change = lambda cur, new: client.post(f"{API}/auth/change-password", headers=h,  # noqa: E731
                                          json={"currentPassword": cur, "newPassword": new})

    assert (await change("wrong", "a-long-enough-one")).status_code == 403
    assert (await change("pw", "short")).status_code == 422
    assert (await change("pw", "admin")).status_code == 422
    assert (await change("pw", "a-long-enough-one")).status_code == 204

    assert await _login(client, "pw") == {}
    assert await _login(client, "a-long-enough-one")
    actions = [r["action"] for r in audit.query(filters={"action": ["password_change", "password_change_failed"]})[0]]
    assert sorted(actions) == ["password_change", "password_change_failed"]


async def test_an_api_token_cannot_change_the_password(client):
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    h = await _login(client)
    key = (await client.post(f"{API}/auth/api-tokens", headers=h, json={"name": "k"})).json()["token"]
    r = await client.post(f"{API}/auth/change-password", headers={"Authorization": f"Bearer {key}"},
                          json={"currentPassword": "pw", "newPassword": "a-long-enough-one"})
    assert r.status_code == 401


@pytest.mark.parametrize("password, ok", [
    ("x" * 11, False), ("x" * 12, True), ("Alice.Martin", False), (" alice.martin ", False), ("alice.martin!", True),
])
def test_policy(password, ok):
    assert (password_policy_error(password, "alice.martin") is None) is ok
