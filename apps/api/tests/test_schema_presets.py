from sqlalchemy import select

from app.core.security import hash_password
from app.models.role import Role
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


async def _create_user(db, client, username: str) -> dict:
    # Give the test user a global role that can create workspaces (creating a
    # workspace now requires workspaces:write). They own only what they create;
    # they are not a member of anyone else's workspace.
    existing = await db.scalar(select(Role).where(Role.name == "ws-user"))
    if existing is None:
        db.add(Role(name="ws-user", scope="global", permissions=["workspaces:write"]))
        await db.commit()
    db.add(User(username=username, password_hash=hash_password("pw"), role="ws-user"))
    await db.commit()
    r = await client.post(
        f"{API}/auth/login", json={"username": username, "password": "pw"}
    )
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _make_workspace(client, headers) -> str:
    r = await client.post(
        f"{API}/workspaces", headers=headers, json={"name": {"en": "WS"}}
    )
    return r.json()["id"]


async def test_global_preset_upsert_and_list(client):
    headers = await _admin_headers(client)

    # Create (PUT = upsert), no workspace → global preset.
    r = await client.put(
        f"{API}/schema-presets/p1",
        headers=headers,
        json={"presetId": "p1", "mapping": {"tables": []}},
    )
    assert r.status_code == 200
    assert r.json()["presetId"] == "p1"
    assert "createdAt" in r.json()

    # Update the same preset via PUT.
    r = await client.put(
        f"{API}/schema-presets/p1",
        headers=headers,
        json={"presetId": "p1", "mapping": {"tables": ["person"]}},
    )
    assert r.status_code == 200 and r.json()["mapping"] == {"tables": ["person"]}

    r = await client.get(f"{API}/schema-presets", headers=headers)
    assert [p["presetId"] for p in r.json()] == ["p1"]

    r = await client.delete(f"{API}/schema-presets/p1", headers=headers)
    assert r.status_code == 204


async def test_body_url_mismatch_rejected(client):
    headers = await _admin_headers(client)
    r = await client.put(
        f"{API}/schema-presets/p1",
        headers=headers,
        json={"presetId": "other", "mapping": {}},
    )
    assert r.status_code == 400


async def test_workspace_preset_permission(client, db):
    admin = await _admin_headers(client)
    ws_id = await _make_workspace(client, admin)

    # Admin (owner) can save a workspace-scoped preset.
    r = await client.put(
        f"{API}/schema-presets/wp",
        headers=admin,
        json={"presetId": "wp", "workspaceId": ws_id, "mapping": {}},
    )
    assert r.status_code == 200

    # A non-member cannot save into that workspace, nor see the preset.
    other = await _create_user(db, client, "bob")
    r = await client.put(
        f"{API}/schema-presets/wp2",
        headers=other,
        json={"presetId": "wp2", "workspaceId": ws_id, "mapping": {}},
    )
    assert r.status_code == 403

    r = await client.get(f"{API}/schema-presets", headers=other)
    assert all(p["presetId"] != "wp" for p in r.json())


async def test_cannot_hijack_existing_preset_by_reparenting(client, db):
    """save() upserts by presetId; a caller must not overwrite/re-parent a preset
    that lives in a workspace they can't access, even if they target their own."""
    admin = await _admin_headers(client)
    ws_a = await _make_workspace(client, admin)
    await client.put(
        f"{API}/schema-presets/secret",
        headers=admin,
        json={"presetId": "secret", "workspaceId": ws_a, "mapping": {"tables": ["a"]}},
    )

    # bob owns his own workspace B but is not a member of A.
    bob = await _create_user(db, client, "bob")
    ws_b = (await client.post(
        f"{API}/workspaces", headers=bob, json={"name": {"en": "B"}}
    )).json()["id"]

    # Overwriting A's preset (known id) — even while targeting B — must be refused,
    # because the caller lacks editor on the preset's CURRENT workspace (A).
    r = await client.put(
        f"{API}/schema-presets/secret",
        headers=bob,
        json={"presetId": "secret", "workspaceId": ws_b, "mapping": {"tables": ["hacked"]}},
    )
    assert r.status_code == 403

    # And to the global pool (workspaceId=null) — same refusal.
    r = await client.put(
        f"{API}/schema-presets/secret",
        headers=bob,
        json={"presetId": "secret", "mapping": {"tables": ["hacked"]}},
    )
    assert r.status_code == 403

    # A's preset is untouched.
    r = await client.get(f"{API}/schema-presets", headers=admin)
    secret = next(p for p in r.json() if p["presetId"] == "secret")
    assert secret["mapping"] == {"tables": ["a"]} and secret["workspaceId"] == ws_a


async def test_preset_persists_author_provenance(client):
    """The creator snapshot (createdBy / createdByDetails) survives the round-trip
    so the schema card can show the author in server mode too."""
    headers = await _admin_headers(client)
    r = await client.put(
        f"{API}/schema-presets/authored",
        headers=headers,
        json={
            "presetId": "authored",
            "mapping": {"tables": []},
            "createdBy": "Ada Lovelace",
            "createdByDetails": {"fullName": "Ada Lovelace", "orcid": "0000-0002-1825-0097"},
        },
    )
    assert r.status_code == 200
    assert r.json()["createdBy"] == "Ada Lovelace"
    assert r.json()["createdByDetails"]["orcid"] == "0000-0002-1825-0097"

    # Persisted (visible on the list endpoint, not just echoed back).
    r = await client.get(f"{API}/schema-presets", headers=headers)
    authored = next(p for p in r.json() if p["presetId"] == "authored")
    assert authored["createdBy"] == "Ada Lovelace"


async def test_preset_keeps_its_creation_date_but_accepts_an_imported_one(client):
    """createdAt is provenance, so an import must be able to restore the repo's
    date onto a row that already exists — while an ordinary re-save, which sends
    none, must not move it.

    The update branch used to drop created_at unconditionally, so a preset pulled
    onto an existing row kept the moment it first appeared on this instance and
    then exported that back as a false creation date. Same bug as
    createdat-git-roundtrip, in the one path that upserts through PUT."""
    headers = await _admin_headers(client)
    body = {"presetId": "dated", "mapping": {"tables": []}}

    r = await client.put(f"{API}/schema-presets/dated", headers=headers, json=body)
    assert r.status_code == 200
    stamped = r.json()["createdAt"]

    # An ordinary re-save carries no createdAt and must leave it alone.
    r = await client.put(
        f"{API}/schema-presets/dated", headers=headers, json={**body, "mapping": {"tables": ["a"]}}
    )
    assert r.json()["createdAt"] == stamped

    # An import carries the repo's date, which is the row's real provenance.
    r = await client.put(
        f"{API}/schema-presets/dated",
        headers=headers,
        json={**body, "createdAt": "2026-08-10T11:24:04.076Z"},
    )
    assert r.status_code == 200
    assert r.json()["createdAt"].startswith("2026-08-10T11:24:04")
