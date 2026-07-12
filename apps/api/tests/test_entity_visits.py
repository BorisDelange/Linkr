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


async def test_record_recovers_from_concurrent_insert_race(db):
    """Simulate the race: the row already exists but this request's initial read
    saw nothing (stale), so record() tries to INSERT and hits the unique
    constraint. It must recover into the update path, not 500."""
    from app.models.entity_visit import EntityVisit
    from app.schemas.entity_visit import EntityVisitRecord
    from app.services import entity_visit_service as svc

    db.add(User(id=1, username="racer", password_hash=hash_password("pw"), role="user"))
    await db.commit()

    # The "winner" row committed by the concurrent request.
    db.add(EntityVisit(user_id=1, entity_type="workspace", entity_id="ws-race", visited_at="t1"))
    await db.commit()

    # Force the first read to miss so record() takes the INSERT branch → IntegrityError.
    original_get = svc._get
    calls = {"n": 0}

    async def flaky_get(db_, user_id, data):
        calls["n"] += 1
        if calls["n"] == 1:
            return None  # stale read: pretend the row isn't there yet
        return await original_get(db_, user_id, data)

    svc._get = flaky_get
    try:
        result = await svc.record(
            db, 1, EntityVisitRecord(entity_type="workspace", entity_id="ws-race", visited_at="t2")
        )
    finally:
        svc._get = original_get

    assert result.visited_at == "t2"  # recovered → updated, not crashed
    visits = await svc.list_for_user(db, 1)
    assert len([v for v in visits if v.entity_id == "ws-race"]) == 1  # still one row


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
