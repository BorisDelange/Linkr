"""Cross-device user preferences on PATCH /auth/me.

Only choices that must follow a person between machines live here — currently
the assistant's "save conversations" consent. Local UI state (which panel is
open, theme) deliberately stays in localStorage.
"""

from app.core.security import hash_password
from app.models.user import User

API = "/api/v1"


async def _admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _make_user(db, client, username: str) -> dict:
    db.add(User(username=username, password_hash=hash_password("pw"), role="user"))
    await db.commit()
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def test_preferences_default_to_empty_and_round_trip(client):
    headers = await _admin(client)
    assert (await client.get(f"{API}/auth/me", headers=headers)).json()["preferences"] == {}

    patched = await client.patch(
        f"{API}/auth/me", headers=headers, json={"preferences": {"saveConversations": False}}
    )
    assert patched.status_code == 200
    assert patched.json()["preferences"] == {"saveConversations": False}

    # Survives a fresh read, i.e. it is actually stored.
    assert (await client.get(f"{API}/auth/me", headers=headers)).json()["preferences"] == {
        "saveConversations": False
    }


async def test_preferences_are_replaced_wholesale_not_merged(client):
    """The column is a single JSON value, so a caller must send the merged
    object. Pinning it here because a partial PATCH silently dropping a
    consent flag back to its default would be the dangerous failure."""
    headers = await _admin(client)
    await client.patch(
        f"{API}/auth/me",
        headers=headers,
        json={"preferences": {"saveConversations": False, "assistantModel": "qwen3.5:4b"}},
    )
    r = await client.patch(
        f"{API}/auth/me", headers=headers, json={"preferences": {"assistantModel": "llama3.2:3b"}}
    )
    assert r.json()["preferences"] == {"assistantModel": "llama3.2:3b"}


async def test_patching_another_field_leaves_preferences_untouched(client):
    headers = await _admin(client)
    await client.patch(
        f"{API}/auth/me", headers=headers, json={"preferences": {"saveConversations": False}}
    )
    r = await client.patch(f"{API}/auth/me", headers=headers, json={"firstName": "Boris"})
    assert r.json()["preferences"] == {"saveConversations": False}
    # MeResponse is a plain BaseModel, so it emits snake_case unlike CamelModel.
    assert r.json()["first_name"] == "Boris"


async def test_preferences_are_per_user(client, db):
    admin = await _admin(client)
    alice = await _make_user(db, client, "alice")

    await client.patch(f"{API}/auth/me", headers=admin, json={"preferences": {"saveConversations": False}})

    assert (await client.get(f"{API}/auth/me", headers=alice)).json()["preferences"] == {}


async def test_me_still_refuses_privilege_fields(client, db):
    """`preferences` joins a schema whose whole point is that it accepts only
    self-editable fields — check the guard still holds."""
    alice = await _make_user(db, client, "alice")
    r = await client.patch(
        f"{API}/auth/me",
        headers=alice,
        json={"preferences": {"a": 1}, "role": "admin", "isActive": False},
    )
    assert r.status_code == 200
    assert r.json()["role"] == "user"
    assert r.json()["is_active"] is True
    assert r.json()["preferences"] == {"a": 1}
