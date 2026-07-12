from app.core.security import hash_password
from app.models.user import User

API = "/api/v1"


async def _admin_headers(client) -> dict:
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw"}
    )
    r = await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "pw"}
    )
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _user_headers(db, client, username: str) -> dict:
    db.add(User(username=username, password_hash=hash_password("pw"), role="user"))
    await db.commit()
    r = await client.post(
        f"{API}/auth/login", json={"username": username, "password": "pw"}
    )
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def test_record_and_list_visit(client):
    headers = await _admin_headers(client)

    r = await client.post(
        f"{API}/visits",
        headers=headers,
        json={"entityType": "workspace", "entityId": "ws-1", "visitedAt": "2026-07-12T10:00:00Z"},
    )
    assert r.status_code == 200
    assert r.json()["entityId"] == "ws-1"

    r = await client.get(f"{API}/visits", headers=headers)
    assert r.status_code == 200
    visits = r.json()
    assert len(visits) == 1
    assert visits[0]["visitedAt"] == "2026-07-12T10:00:00Z"


async def test_record_is_upsert(client):
    headers = await _admin_headers(client)

    await client.post(
        f"{API}/visits",
        headers=headers,
        json={"entityType": "project", "entityId": "p-1", "visitedAt": "2026-07-12T10:00:00Z"},
    )
    await client.post(
        f"{API}/visits",
        headers=headers,
        json={"entityType": "project", "entityId": "p-1", "visitedAt": "2026-07-12T12:00:00Z"},
    )

    r = await client.get(f"{API}/visits", headers=headers)
    visits = [v for v in r.json() if v["entityId"] == "p-1"]
    assert len(visits) == 1
    assert visits[0]["visitedAt"] == "2026-07-12T12:00:00Z"


async def test_visits_are_per_user(client, db):
    admin = await _admin_headers(client)
    other = await _user_headers(db, client, "bob")

    await client.post(
        f"{API}/visits",
        headers=admin,
        json={"entityType": "workspace", "entityId": "ws-shared", "visitedAt": "2026-07-12T10:00:00Z"},
    )

    r = await client.get(f"{API}/visits", headers=other)
    assert r.status_code == 200
    assert r.json() == []
