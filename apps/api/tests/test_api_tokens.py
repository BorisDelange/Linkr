"""Personal API tokens: authenticate as their user, never manage tokens."""

from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.core.security import hash_password
from app.models.api_token import ApiToken
from app.models.user import User
from app.services.api_token_service import hash_token

API = "/api/v1"


async def _login(db, client, username: str, role: str = "user") -> dict:
    db.add(User(username=username, password_hash=hash_password("pw"), role=role))
    await db.commit()
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _mint(client, session: dict, **body) -> dict:
    r = await client.post(f"{API}/auth/api-tokens", headers=session, json={"name": "mcp", **body})
    assert r.status_code == 201, r.text
    return r.json()


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def test_token_authenticates_as_its_user(client, db):
    session = await _login(db, client, "alice")
    created = await _mint(client, session)
    assert created["token"].startswith("lnk_")
    assert created["prefix"] == created["token"][4:12]

    r = await client.get(f"{API}/auth/me", headers=_bearer(created["token"]))
    assert r.status_code == 200
    assert r.json()["username"] == "alice"


async def test_only_the_hash_is_stored(client, db):
    session = await _login(db, client, "alice")
    created = await _mint(client, session)
    row = await db.scalar(select(ApiToken).where(ApiToken.id == created["id"]))
    assert row.token_hash == hash_token(created["token"])
    assert created["token"] not in (row.token_hash, row.prefix)

    listed = (await client.get(f"{API}/auth/api-tokens", headers=session)).json()
    assert [t["id"] for t in listed] == [created["id"]]
    assert "token" not in listed[0] and "tokenHash" not in listed[0]


async def test_last_used_is_stamped(client, db):
    session = await _login(db, client, "alice")
    created = await _mint(client, session)
    await client.get(f"{API}/auth/me", headers=_bearer(created["token"]))
    listed = (await client.get(f"{API}/auth/api-tokens", headers=session)).json()
    assert listed[0]["lastUsedAt"] is not None


async def test_revoked_token_is_refused_but_still_listed(client, db):
    session = await _login(db, client, "alice")
    created = await _mint(client, session)
    r = await client.delete(f"{API}/auth/api-tokens/{created['id']}", headers=session)
    assert r.status_code == 200
    assert r.json()["revokedAt"] is not None

    assert (await client.get(f"{API}/auth/me", headers=_bearer(created["token"]))).status_code == 401
    listed = (await client.get(f"{API}/auth/api-tokens", headers=session)).json()
    assert listed[0]["revokedAt"] is not None


async def test_expired_token_is_refused(client, db):
    session = await _login(db, client, "alice")
    created = await _mint(client, session, expiresInDays=30)
    assert created["expiresAt"] is not None
    row = await db.get(ApiToken, created["id"])
    row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    await db.commit()

    assert (await client.get(f"{API}/auth/me", headers=_bearer(created["token"]))).status_code == 401


async def test_unknown_token_is_refused(client, db):
    assert (await client.get(f"{API}/auth/me", headers=_bearer("lnk_nope"))).status_code == 401


async def test_inactive_user_is_refused(client, db):
    session = await _login(db, client, "alice")
    created = await _mint(client, session)
    user = await db.scalar(select(User).where(User.username == "alice"))
    user.is_active = False
    await db.commit()

    assert (await client.get(f"{API}/auth/me", headers=_bearer(created["token"]))).status_code == 401


async def test_token_cannot_manage_tokens(client, db):
    session = await _login(db, client, "alice")
    created = await _mint(client, session)
    headers = _bearer(created["token"])

    assert (await client.get(f"{API}/auth/api-tokens", headers=headers)).status_code == 401
    r = await client.post(f"{API}/auth/api-tokens", headers=headers, json={"name": "evil"})
    assert r.status_code == 401
    r = await client.delete(f"{API}/auth/api-tokens/{created['id']}", headers=headers)
    assert r.status_code == 401
    assert (await client.get(f"{API}/auth/me", headers=headers)).status_code == 200


async def test_another_user_cannot_see_or_revoke(client, db):
    alice = await _login(db, client, "alice")
    bob = await _login(db, client, "bob")
    created = await _mint(client, alice)

    assert (await client.get(f"{API}/auth/api-tokens", headers=bob)).json() == []
    r = await client.delete(f"{API}/auth/api-tokens/{created['id']}", headers=bob)
    assert r.status_code == 404
    assert (await client.get(f"{API}/auth/me", headers=_bearer(created["token"]))).status_code == 200


async def test_blank_name_is_rejected(client, db):
    session = await _login(db, client, "alice")
    r = await client.post(f"{API}/auth/api-tokens", headers=session, json={"name": "   "})
    assert r.status_code == 422


async def test_list_is_newest_first(client, db):
    session = await _login(db, client, "alice")
    first = await _mint(client, session)
    second = await _mint(client, session)
    row = await db.get(ApiToken, first["id"])
    row.created_at = datetime.now(timezone.utc) - timedelta(days=1)
    await db.commit()

    listed = (await client.get(f"{API}/auth/api-tokens", headers=session)).json()
    assert [t["id"] for t in listed] == [second["id"], first["id"]]
