"""Membership + the 3-dimension role resolution (global / workspace / project).

A project override REPLACES the inherited workspace role — it can widen or
restrict. These tests drive the endpoints that actually consume the resolution
(cohorts = a project-scoped resource) so they exercise permissions end to end."""

from app.core.security import hash_password
from app.models.user import User

API = "/api/v1"


async def _bootstrap_admin(client) -> dict:
    await client.post(f"{API}/setup/initialize", json={"username": "admin", "password": "pw"})
    r = await client.post(f"{API}/auth/login", json={"username": "admin", "password": "pw"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _make_user(db, client, username: str) -> tuple[int, dict]:
    u = User(username=username, password_hash=hash_password("pw"), role="user")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw"})
    return u.id, {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _workspace(client, headers) -> str:
    r = await client.post(f"{API}/workspaces", headers=headers, json={"name": {"en": "W"}})
    return r.json()["id"]


async def _project(client, headers, workspace_id: str) -> str:
    r = await client.post(
        f"{API}/projects",
        headers=headers,
        json={"name": {"en": "P"}, "workspaceId": workspace_id},
    )
    return r.json()["uid"]


_cohort_seq = 0


async def _make_cohort(client, headers, project_uid: str):
    global _cohort_seq
    _cohort_seq += 1
    return await client.post(
        f"{API}/cohorts",
        headers=headers,
        json={
            "id": f"cohort-{_cohort_seq}",
            "projectUid": project_uid,
            "name": "C",
            "level": "person",
        },
    )


async def test_my_role_reflects_effective_role(client, db):
    admin = await _bootstrap_admin(client)
    ws = await _workspace(client, admin)
    proj = await _project(client, admin, ws)
    bob_id, bob = await _make_user(db, client, "bob")

    # Non-member: no role on either.
    assert (await client.get(f"{API}/workspaces/{ws}/my-role", headers=bob)).json()["role"] is None
    assert (await client.get(f"{API}/projects/{proj}/my-role", headers=bob)).json()["role"] is None

    # Workspace editor → inherited editor on the project.
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin,
                     json={"userId": bob_id, "role": "editor"})
    assert (await client.get(f"{API}/workspaces/{ws}/my-role", headers=bob)).json()["role"] == "editor"
    assert (await client.get(f"{API}/projects/{proj}/my-role", headers=bob)).json()["role"] == "editor"

    # Project override wins (owner here, hidden there).
    await client.put(f"{API}/projects/{proj}/members", headers=admin,
                     json={"userId": bob_id, "role": "owner"})
    assert (await client.get(f"{API}/projects/{proj}/my-role", headers=bob)).json()["role"] == "owner"

    # Admin is always owner.
    assert (await client.get(f"{API}/workspaces/{ws}/my-role", headers=admin)).json()["role"] == "owner"


async def test_my_role_returns_permissions_for_gating(client, db):
    admin = await _bootstrap_admin(client)
    ws = await _workspace(client, admin)
    proj = await _project(client, admin, ws)
    bob_id, bob = await _make_user(db, client, "bob")

    # Workspace viewer: read-only permissions on the project, no writes.
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin,
                     json={"userId": bob_id, "role": "viewer"})
    perms = (await client.get(f"{API}/projects/{proj}/my-role", headers=bob)).json()["permissions"]
    assert "cohorts:read" in perms
    assert "cohorts:write" not in perms
    assert "ide:execute" not in perms

    # Editor override on the project: gains write + ide:execute there.
    await client.put(f"{API}/projects/{proj}/members", headers=admin,
                     json={"userId": bob_id, "role": "editor"})
    perms = (await client.get(f"{API}/projects/{proj}/my-role", headers=bob)).json()["permissions"]
    assert "cohorts:write" in perms and "ide:execute" in perms

    # Admin gets the full catalogue.
    perms = (await client.get(f"{API}/projects/{proj}/my-role", headers=admin)).json()["permissions"]
    assert "cohorts:delete" in perms and "workspaces:write" in perms


async def test_workspace_owner_manages_members(client, db):
    admin = await _bootstrap_admin(client)
    ws = await _workspace(client, admin)
    bob_id, bob = await _make_user(db, client, "bob")

    # Non-member can't list.
    assert (await client.get(f"{API}/workspaces/{ws}/members", headers=bob)).status_code == 403

    # Owner (admin) adds bob as editor.
    r = await client.put(
        f"{API}/workspaces/{ws}/members", headers=admin,
        json={"userId": bob_id, "role": "editor"},
    )
    assert r.status_code == 200 and r.json()["role"] == "editor"

    # bob now sees the workspace and its member list.
    assert (await client.get(f"{API}/workspaces/{ws}", headers=bob)).status_code == 200
    members = (await client.get(f"{API}/workspaces/{ws}/members", headers=bob)).json()
    assert any(m["userId"] == bob_id and m["role"] == "editor" for m in members)

    # bob (editor, not owner) cannot manage members.
    assert (await client.put(
        f"{API}/workspaces/{ws}/members", headers=bob,
        json={"userId": bob_id, "role": "owner"},
    )).status_code == 403


async def test_add_member_by_username(client, db):
    admin = await _bootstrap_admin(client)
    ws = await _workspace(client, admin)
    _, _ = await _make_user(db, client, "carol")

    r = await client.put(
        f"{API}/workspaces/{ws}/members", headers=admin,
        json={"username": "carol", "role": "viewer"},
    )
    assert r.status_code == 200 and r.json()["role"] == "viewer"

    # Unknown username → 404.
    r = await client.put(
        f"{API}/workspaces/{ws}/members", headers=admin,
        json={"username": "ghost", "role": "viewer"},
    )
    assert r.status_code == 404


async def test_cannot_remove_last_owner(client, db):
    admin = await _bootstrap_admin(client)
    ws = await _workspace(client, admin)
    # admin is the sole owner (auto-added on create); removing them is refused.
    me = (await client.get(f"{API}/auth/me", headers=admin)).json()
    r = await client.delete(f"{API}/workspaces/{ws}/members/{me['id']}", headers=admin)
    assert r.status_code == 400


async def test_inherited_workspace_role_applies_to_project(client, db):
    admin = await _bootstrap_admin(client)
    ws = await _workspace(client, admin)
    proj = await _project(client, admin, ws)
    bob_id, bob = await _make_user(db, client, "bob")

    # bob as workspace viewer: can read cohorts, cannot create.
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin,
                     json={"userId": bob_id, "role": "viewer"})
    assert (await client.get(f"{API}/cohorts?projectUid={proj}", headers=bob)).status_code == 200
    assert (await _make_cohort(client, bob, proj)).status_code == 403

    # Upgrade to editor at workspace level: now inherited on the project.
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin,
                     json={"userId": bob_id, "role": "editor"})
    assert (await _make_cohort(client, bob, proj)).status_code == 201


async def test_project_override_widens(client, db):
    admin = await _bootstrap_admin(client)
    ws = await _workspace(client, admin)
    proj = await _project(client, admin, ws)
    bob_id, bob = await _make_user(db, client, "bob")

    # Workspace viewer (can't create cohorts)...
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin,
                     json={"userId": bob_id, "role": "viewer"})
    assert (await _make_cohort(client, bob, proj)).status_code == 403

    # ...but an editor override on THIS project lets him create.
    await client.put(f"{API}/projects/{proj}/members", headers=admin,
                     json={"userId": bob_id, "role": "editor"})
    assert (await _make_cohort(client, bob, proj)).status_code == 201


async def test_project_override_restricts(client, db):
    admin = await _bootstrap_admin(client)
    ws = await _workspace(client, admin)
    proj = await _project(client, admin, ws)
    bob_id, bob = await _make_user(db, client, "bob")

    # Workspace editor (could create) but restricted to viewer on this project.
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin,
                     json={"userId": bob_id, "role": "editor"})
    await client.put(f"{API}/projects/{proj}/members", headers=admin,
                     json={"userId": bob_id, "role": "viewer"})
    assert (await client.get(f"{API}/cohorts?projectUid={proj}", headers=bob)).status_code == 200
    assert (await _make_cohort(client, bob, proj)).status_code == 403

    # Dropping the override restores the inherited editor role.
    assert (await client.delete(
        f"{API}/projects/{proj}/members/{bob_id}", headers=admin
    )).status_code == 204
    assert (await _make_cohort(client, bob, proj)).status_code == 201


async def test_atomic_permission_enforced_server_side(client, db):
    """Server gates on the exact permission, not rank: if an admin customises the
    editor role to drop cohorts:write, an editor member can no longer create
    cohorts even though their rank is editor (proves permission- not rank-based)."""
    admin = await _bootstrap_admin(client)
    ws = await _workspace(client, admin)
    proj = await _project(client, admin, ws)
    bob_id, bob = await _make_user(db, client, "bob")
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin,
                     json={"userId": bob_id, "role": "editor"})

    # Editor can create cohorts by default.
    assert (await _make_cohort(client, bob, proj)).status_code == 201

    # Admin customises the editor role: strip cohorts:write.
    editor = next(r for r in (await client.get(f"{API}/roles", headers=admin)).json() if r["name"] == "editor")
    perms = [p for p in editor["permissions"] if p != "cohorts:write"]
    assert (await client.patch(f"{API}/roles/{editor['id']}", headers=admin,
            json={"permissions": perms})).status_code == 200

    # Same editor is now refused — the gate is the atomic permission, not the rank.
    assert (await _make_cohort(client, bob, proj)).status_code == 403
    assert (await client.get(f"{API}/cohorts?projectUid={proj}", headers=bob)).status_code == 200


async def test_editor_cannot_manage_members_or_delete_project(client, db):
    """editor holds write on content but NOT members:write nor
    project-settings:delete — those are owner-only, enforced server-side."""
    admin = await _bootstrap_admin(client)
    ws = await _workspace(client, admin)
    proj = await _project(client, admin, ws)
    bob_id, bob = await _make_user(db, client, "bob")
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin,
                     json={"userId": bob_id, "role": "editor"})

    # Editor can see members but not add/remove them, and can't delete the project.
    assert (await client.get(f"{API}/workspaces/{ws}/members", headers=bob)).status_code == 200
    assert (await client.put(f"{API}/workspaces/{ws}/members", headers=bob,
            json={"userId": bob_id, "role": "owner"})).status_code == 403
    assert (await client.delete(f"{API}/projects/{proj}", headers=bob)).status_code == 403

    # Owner can.
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin,
                     json={"userId": bob_id, "role": "owner"})
    assert (await client.delete(f"{API}/projects/{proj}", headers=bob)).status_code == 204


async def test_project_override_none_hides_from_workspace_member(client, db):
    admin = await _bootstrap_admin(client)
    ws = await _workspace(client, admin)
    proj = await _project(client, admin, ws)
    bob_id, bob = await _make_user(db, client, "bob")

    # Workspace editor sees the project by inheritance.
    await client.put(f"{API}/workspaces/{ws}/members", headers=admin,
                     json={"userId": bob_id, "role": "editor"})
    assert (await client.get(f"{API}/cohorts?projectUid={proj}", headers=bob)).status_code == 200
    assert any(p["uid"] == proj for p in (await client.get(f"{API}/projects", headers=bob)).json())

    # A "none" override hides it: 403 on the project's resources AND absent from the list.
    await client.put(f"{API}/projects/{proj}/members", headers=admin,
                     json={"userId": bob_id, "role": "none"})
    assert (await client.get(f"{API}/cohorts?projectUid={proj}", headers=bob)).status_code == 403
    assert all(p["uid"] != proj for p in (await client.get(f"{API}/projects", headers=bob)).json())

    # Workspace roles cannot be "none".
    assert (await client.put(f"{API}/workspaces/{ws}/members", headers=admin,
            json={"userId": bob_id, "role": "none"})).status_code == 422


async def _make_user_with_role(db, client, username: str, role_name: str) -> tuple[int, dict]:
    u = User(username=username, password_hash=hash_password("pw"), role=role_name)
    db.add(u)
    await db.commit()
    await db.refresh(u)
    r = await client.post(f"{API}/auth/login", json={"username": username, "password": "pw"})
    return u.id, {"Authorization": f"Bearer {r.json()['access_token']}"}


async def test_global_grant_gives_cross_workspace_access(client, db):
    admin = await _bootstrap_admin(client)
    ws = await _workspace(client, admin)
    proj = await _project(client, admin, ws)

    # A custom GLOBAL role holding all-workspaces:write + all-projects:write —
    # the write action maps to editor rank everywhere.
    role = (await client.post(f"{API}/roles", headers=admin, json={
        "name": "cross-editor",
        "scope": "global",
        "permissions": ["all-workspaces:write", "all-projects:write"],
    })).json()
    assert role["name"] == "cross-editor"

    bob_id, bob = await _make_user_with_role(db, client, "bob", "cross-editor")

    # bob is NOT a member of the workspace, yet the grant confers editor access:
    # he sees the project and can create cohorts in it.
    assert (await client.get(f"{API}/workspaces/{ws}/my-role", headers=bob)).json()["role"] == "editor"
    assert (await client.get(f"{API}/projects/{proj}/my-role", headers=bob)).json()["role"] == "editor"
    assert (await _make_cohort(client, bob, proj)).status_code == 201
    assert any(p["uid"] == proj for p in (await client.get(f"{API}/projects", headers=bob)).json())


async def test_global_grant_read_only_cannot_write(client, db):
    admin = await _bootstrap_admin(client)
    ws = await _workspace(client, admin)
    proj = await _project(client, admin, ws)

    await client.post(f"{API}/roles", headers=admin, json={
        "name": "cross-viewer",
        "scope": "global",
        "permissions": ["all-workspaces:read", "all-projects:read"],
    })
    _, bob = await _make_user_with_role(db, client, "bob", "cross-viewer")

    # read grant → viewer everywhere: can list, cannot create.
    assert (await client.get(f"{API}/projects/{proj}/my-role", headers=bob)).json()["role"] == "viewer"
    assert (await client.get(f"{API}/cohorts?projectUid={proj}", headers=bob)).status_code == 200
    assert (await _make_cohort(client, bob, proj)).status_code == 403


async def test_project_override_shares_with_non_workspace_member(client, db):
    admin = await _bootstrap_admin(client)
    ws = await _workspace(client, admin)
    proj = await _project(client, admin, ws)
    bob_id, bob = await _make_user(db, client, "bob")

    # bob is NOT a workspace member; a project override grants access anyway.
    assert (await client.get(f"{API}/cohorts?projectUid={proj}", headers=bob)).status_code == 403
    await client.put(f"{API}/projects/{proj}/members", headers=admin,
                     json={"userId": bob_id, "role": "editor"})
    assert (await client.get(f"{API}/cohorts?projectUid={proj}", headers=bob)).status_code == 200
    # And the project shows up in his project list.
    projects = (await client.get(f"{API}/projects", headers=bob)).json()
    assert any(p["uid"] == proj for p in projects)
