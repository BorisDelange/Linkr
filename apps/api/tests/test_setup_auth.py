API = "/api/v1"


async def test_setup_status_and_initialize(client):
    r = await client.get(f"{API}/setup/status")
    assert r.status_code == 200
    assert r.json() == {"needs_setup": True}

    r = await client.post(
        f"{API}/setup/initialize",
        json={"username": "admin", "password": "pw", "email": "a@b.c"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["username"] == "admin"
    assert body["role"] == "admin"

    r = await client.get(f"{API}/setup/status")
    assert r.json() == {"needs_setup": False}

    # Second initialize is rejected once a user exists.
    r = await client.post(
        f"{API}/setup/initialize", json={"username": "x", "password": "y"}
    )
    assert r.status_code == 400


async def test_login_me_refresh(client):
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw"}
    )

    r = await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "pw"}
    )
    assert r.status_code == 200
    tokens = r.json()
    assert tokens["token_type"] == "bearer"
    assert tokens["user"]["username"] == "admin"

    headers = {"Authorization": f"Bearer {tokens['access_token']}"}
    r = await client.get(f"{API}/auth/me", headers=headers)
    assert r.status_code == 200
    assert r.json()["username"] == "admin"

    r = await client.post(
        f"{API}/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    assert r.status_code == 200
    assert r.json()["access_token"]


async def test_login_bad_password(client):
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw"}
    )
    r = await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "wrong"}
    )
    assert r.status_code == 401


async def test_me_requires_token(client):
    r = await client.get(f"{API}/auth/me")
    assert r.status_code == 401  # HTTPBearer rejects missing credentials
