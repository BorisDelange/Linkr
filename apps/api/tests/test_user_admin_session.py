"""Creating, changing and deleting accounts takes an admin's session, not an API
key, and an admin sets their own password only by proving the current one."""

API = "/api/v1"
PASSWORD = "pw-for-tests-only"


async def _admin(client) -> tuple[dict, int]:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": PASSWORD})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": PASSWORD})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}, r.json()["user"]["id"]


async def _key(client, session: dict) -> dict:
    r = await client.post(f"{API}/auth/api-tokens", headers=session, json={"name": "agent"})
    return {"Authorization": f"Bearer {r.json()['token']}"}


async def test_an_admin_api_key_cannot_create_change_or_delete_accounts(client):
    session, admin_id = await _admin(client)
    key = await _key(client, session)
    other = await client.post(f"{API}/users", headers=session,
                              json={"username": "bob", "password": "dummy-User-pass-5529", "role": "user"})
    assert other.status_code == 201

    assert (await client.post(f"{API}/users", headers=key,
                              json={"username": "agentmade", "password": "dummy-User-pass-5529", "role": "admin"})
            ).status_code == 401
    assert (await client.patch(f"{API}/users/{admin_id}", headers=key,
                               json={"password": "dummy-Changed-pass-7713"})).status_code == 401
    assert (await client.patch(f"{API}/users/{other.json()['id']}", headers=key,
                               json={"profession": "x"})).status_code == 401
    assert (await client.delete(f"{API}/users/{other.json()['id']}", headers=key)).status_code == 401
    assert (await client.get(f"{API}/users", headers=key)).status_code == 200
    login = await client.post(f"{API}/auth/login", json={"username": "agentmade", "password": "dummy-User-pass-5529"})
    assert login.status_code == 401


async def test_an_admin_session_does_not_set_its_own_password_without_the_current_one(client):
    session, admin_id = await _admin(client)
    r = await client.patch(f"{API}/users/{admin_id}", headers=session, json={"password": "dummy-Changed-pass-7713"})
    assert r.status_code == 400
    assert (await client.post(f"{API}/auth/login", json={"username": "admin", "password": PASSWORD})).status_code == 200
    assert (await client.patch(f"{API}/users/{admin_id}", headers=session, json={"profession": "Physician"})
            ).status_code == 200


async def test_an_admin_session_still_manages_other_accounts(client):
    session, _ = await _admin(client)
    created = await client.post(f"{API}/users", headers=session,
                                json={"username": "bob", "password": "dummy-User-pass-5529", "role": "user"})
    assert created.status_code == 201
    bob = created.json()["id"]
    assert (await client.patch(f"{API}/users/{bob}", headers=session, json={"password": "dummy-Reset-pass-4410"})
            ).status_code == 200
    assert (await client.post(f"{API}/auth/login", json={"username": "bob", "password": "dummy-Reset-pass-4410"})
            ).status_code == 200
    assert (await client.delete(f"{API}/users/{bob}", headers=session)).status_code == 204
