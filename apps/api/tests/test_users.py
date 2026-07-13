from app.core.security import hash_password
from app.models.user import User

API = "/api/v1"


async def _bootstrap_admin(client) -> dict:
    await client.post(
        f"{API}/setup/initialize", json={"username": "admin", "password": "pw"}
    )
    r = await client.post(
        f"{API}/auth/login", json={"username": "admin", "password": "pw"}
    )
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _login(client, username, password="pw") -> dict:
    r = await client.post(
        f"{API}/auth/login", json={"username": username, "password": password}
    )
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def test_user_crud_and_identity_fields(client):
    headers = await _bootstrap_admin(client)

    r = await client.post(
        f"{API}/users",
        headers=headers,
        json={
            "username": "alice",
            "password": "secret1",
            "role": "user",
            "firstName": "Alice",
            "lastName": "Martin",
            "affiliation": "CHU Rennes",
            "profession": "Data scientist",
            "orcid": "0000-0002-1234-5678",
        },
    )
    assert r.status_code == 201
    u = r.json()
    assert u["firstName"] == "Alice" and u["affiliation"] == "CHU Rennes"
    assert u["orcid"] == "0000-0002-1234-5678"
    # Password hash must never leak.
    assert "passwordHash" not in u and "password" not in u
    uid = u["id"]

    # The created user can actually log in with the admin-set password.
    alice = await _login(client, "alice", "secret1")

    r = await client.get(f"{API}/users", headers=headers)
    assert any(x["id"] == uid for x in r.json())

    r = await client.patch(
        f"{API}/users/{uid}", headers=headers, json={"profession": "Physician"}
    )
    assert r.status_code == 200 and r.json()["profession"] == "Physician"

    # Password reset via update.
    r = await client.patch(
        f"{API}/users/{uid}", headers=headers, json={"password": "newpass"}
    )
    assert r.status_code == 200
    await _login(client, "alice", "newpass")

    r = await client.delete(f"{API}/users/{uid}", headers=headers)
    assert r.status_code == 204
    assert (await client.get(f"{API}/users/{uid}", headers=headers)).status_code == 404
    # Sanity: alice's stale token still decodes but user is gone → 401.
    assert (await client.get(f"{API}/users", headers=alice)).status_code == 401


async def test_duplicate_username_rejected(client):
    headers = await _bootstrap_admin(client)
    body = {"username": "dup", "password": "pw"}
    assert (await client.post(f"{API}/users", headers=headers, json=body)).status_code == 201
    assert (await client.post(f"{API}/users", headers=headers, json=body)).status_code == 409


async def test_rename_username_keeps_id_and_rejects_clash(client):
    headers = await _bootstrap_admin(client)
    a = (await client.post(f"{API}/users", headers=headers, json={"username": "alice", "password": "pw"})).json()
    (await client.post(f"{API}/users", headers=headers, json={"username": "bob", "password": "pw"}))

    # Rename alice → alice2: same id (memberships keyed on id are unaffected).
    r = await client.patch(f"{API}/users/{a['id']}", headers=headers, json={"username": "alice2"})
    assert r.status_code == 200
    assert r.json()["id"] == a["id"] and r.json()["username"] == "alice2"

    # Renaming onto an existing username is refused.
    r = await client.patch(f"{API}/users/{a['id']}", headers=headers, json={"username": "bob"})
    assert r.status_code == 409


async def test_users_admin_only(client, db):
    await _bootstrap_admin(client)
    db.add(User(username="bob", password_hash=hash_password("pw"), role="user"))
    await db.commit()
    bob = await _login(client, "bob")

    assert (await client.get(f"{API}/users", headers=bob)).status_code == 403
    assert (
        await client.post(f"{API}/users", headers=bob, json={"username": "x", "password": "pw"})
    ).status_code == 403


async def test_directory_available_to_any_user(client, db):
    """The light directory (id+username) is readable by non-admins (member
    pickers need it) and exposes no email/role."""
    await _bootstrap_admin(client)
    db.add(User(username="bob", password_hash=hash_password("pw"), role="user"))
    await db.commit()
    bob = await _login(client, "bob")

    r = await client.get(f"{API}/users/directory", headers=bob)
    assert r.status_code == 200
    entries = r.json()
    assert any(e["username"] == "bob" for e in entries)
    # The directory exposes id/username + public professional identity fields
    # (used to build author provenance snapshots) but must NOT leak sensitive
    # fields (email, role, password, is_active).
    allowed = {"id", "username", "firstName", "lastName", "affiliation", "profession", "orcid"}
    for e in entries:
        assert set(e.keys()) <= allowed
        assert "email" not in e and "role" not in e and "isActive" not in e


async def test_cannot_remove_last_admin(client):
    headers = await _bootstrap_admin(client)
    me = (await client.get(f"{API}/users", headers=headers)).json()[0]

    # Cannot delete the only admin.
    assert (await client.delete(f"{API}/users/{me['id']}", headers=headers)).status_code == 400
    # Cannot demote the only admin.
    r = await client.patch(f"{API}/users/{me['id']}", headers=headers, json={"role": "user"})
    assert r.status_code == 400
    # Cannot deactivate the only admin.
    r = await client.patch(f"{API}/users/{me['id']}", headers=headers, json={"isActive": False})
    assert r.status_code == 400

    # With a second admin, demoting the first is allowed.
    await client.post(
        f"{API}/users",
        headers=headers,
        json={"username": "admin2", "password": "pw", "role": "admin"},
    )
    r = await client.patch(f"{API}/users/{me['id']}", headers=headers, json={"role": "user"})
    assert r.status_code == 200
