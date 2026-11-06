"""Settings (account-level) versioning: export omits secrets, import upserts by
stable identity, and hash-less users land disabled."""

import io
import json
import zipfile
from datetime import datetime, timezone

from sqlalchemy import select

from app.models.organization import Organization
from app.core.permissions import ALL_PERMISSIONS, GLOBAL_PERMISSIONS, has_global_permission
from app.models.role import Role
from app.models.user import User
from app.services import settings_import_service
from app.services.settings_export_assemble import (
    SettingsSelection,
    assemble_settings_zip,
    build_settings_tree,
)


def _read_zip(data: bytes) -> dict[str, dict]:
    out = {}
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for name in zf.namelist():
            out[name] = json.loads(zf.read(name).decode("utf-8"))
    return out


async def _seed(db):
    db.add(Organization(id="org-1", name={"en": "RiCDC"}, website="https://ricdc.fr"))
    db.add(
        User(
            username="alice",
            email="alice@x.fr",
            first_name="Alice",
            affiliation={"en": "CHU"},
            role="admin",
            password_hash="hashed-secret",
            is_active=True,
        )
    )
    db.add(
        Role(
            name="curator",
            label={"en": "Curator"},
            scope="workspace",
            is_system=False,
            permissions=[],
        )
    )
    await db.commit()


async def test_export_omits_password_and_isactive(db):
    await _seed(db)
    tree = await build_settings_tree(db, SettingsSelection())
    users = json.loads(tree["users.json"].decode())
    assert users[0]["username"] == "alice"
    # Never export the hash, is_active, or any auth/session field.
    for forbidden in ("passwordHash", "password_hash", "isActive", "authProvider", "id"):
        assert forbidden not in users[0]
    assert users[0]["affiliation"] == {"en": "CHU"}


async def test_export_keeps_createdat_drops_updatedat(db):
    """createdAt is stable provenance (kept); updatedAt churns (dropped) — across
    users, roles and organizations."""
    await _seed(db)
    tree = await build_settings_tree(db, SettingsSelection())
    for path in ("users.json", "roles.json", "organizations.json"):
        row = json.loads(tree[path].decode())[0]
        assert "createdAt" in row and row["createdAt"], f"{path} lost createdAt"
        assert "updatedAt" not in row, f"{path} leaked updatedAt"


# The file's date, as exported: UTC with no offset.
FILE_DATE = datetime(2020, 3, 4, 5, 6, 7, tzinfo=timezone.utc)


def _utc(dt: datetime) -> datetime:
    """The instant a stored date stands for: SQLite hands back naive UTC, Postgres aware."""
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def test_import_preserves_createdat_on_new_records(db):
    """A created org/user/role takes its createdAt from the file (round-trip stable),
    not a fresh now()."""
    await settings_import_service.import_settings_tree(
        db,
        _tree(
            orgs=[{"id": "org-9", "name": {"en": "X"}, "createdAt": "2020-03-04T05:06:07"}],
            users=[{"username": "carol", "role": "user", "createdAt": "2020-03-04T05:06:07"}],
            roles=[{"name": "auditor", "createdAt": "2020-03-04T05:06:07"}],
        ),
    )
    org = await db.get(Organization, "org-9")
    carol = await db.scalar(select(User).where(User.username == "carol"))
    role = await db.scalar(select(Role).where(Role.name == "auditor"))
    assert _utc(org.created_at) == _utc(carol.created_at) == _utc(role.created_at) == FILE_DATE


async def test_import_takes_file_createdat_for_seeded_system_roles(db):
    """A system role already exists before any import (seed_default_roles runs at
    first startup), so the import matches it by name and takes the update branch.
    Its date is this instance's install time, not provenance — the file's wins."""
    db.add(Role(name="admin", label={"en": "Admin"}, scope="workspace", is_system=True, permissions=[]))
    db.add(Role(name="curator", label={"en": "Curator"}, scope="workspace", is_system=False, permissions=[]))
    await db.commit()
    local_curator_date = _utc((await db.scalar(select(Role).where(Role.name == "curator"))).created_at)

    await settings_import_service.import_settings_tree(
        db,
        _tree(roles=[
            {"name": "admin", "createdAt": "2020-03-04T05:06:07"},
            {"name": "curator", "createdAt": "2020-03-04T05:06:07"},
        ]),
    )

    admin = await db.scalar(select(Role).where(Role.name == "admin"))
    assert _utc(admin.created_at) == FILE_DATE
    # A role a human made on THIS instance keeps its own date, like orgs/users.
    curator = await db.scalar(select(Role).where(Role.name == "curator"))
    assert _utc(curator.created_at) == local_curator_date


async def test_export_keys_follow_authored_order(db):
    """The files are written in the order the dicts declare — a profile reads as a
    profile. A private serializer once sorted them alphabetically instead."""
    await _seed(db)
    tree = await build_settings_tree(db, SettingsSelection())
    user = json.loads(tree["users.json"].decode())[0]
    assert list(user) == [
        "username", "role", "firstName", "lastName", "email",
        "profession", "orcid", "affiliation", "createdAt",
    ]


async def test_export_omits_unchecked_entities(db):
    await _seed(db)
    tree = await build_settings_tree(
        db, SettingsSelection(organizations=True, users=False, roles=False)
    )
    assert "organizations.json" in tree
    assert "users.json" not in tree
    assert "roles.json" not in tree


async def test_export_is_deterministic(db):
    await _seed(db)
    a = await assemble_settings_zip(db, SettingsSelection())
    b = await assemble_settings_zip(db, SettingsSelection())
    assert _read_zip(a) == _read_zip(b)


def _tree(orgs=None, users=None, roles=None) -> dict[str, bytes]:
    tree = {}
    if orgs is not None:
        tree["organizations.json"] = json.dumps(orgs).encode()
    if users is not None:
        tree["users.json"] = json.dumps(users).encode()
    if roles is not None:
        tree["roles.json"] = json.dumps(roles).encode()
    return tree


async def test_import_new_user_is_disabled_without_password(db):
    report = await settings_import_service.import_settings_tree(
        db, _tree(users=[{"username": "bob", "email": "b@x.fr", "role": "user"}])
    )
    assert report.users_created == 1
    bob = await db.scalar(select(User).where(User.username == "bob"))
    assert bob.password_hash is None
    assert bob.is_active is False  # no password → disabled until an admin sets one


async def test_import_existing_user_keeps_password_and_active(db):
    await _seed(db)
    # Re-import alice with an updated affiliation.
    await settings_import_service.import_settings_tree(
        db,
        _tree(users=[{"username": "alice", "affiliation": {"en": "New CHU"}, "role": "admin"}]),
    )
    alice = await db.scalar(select(User).where(User.username == "alice"))
    assert alice.affiliation == {"en": "New CHU"}  # profile updated
    assert alice.password_hash == "hashed-secret"  # untouched
    assert alice.is_active is True  # an active account is never disabled by import


async def test_import_unknown_role_falls_back_to_user(db):
    report = await settings_import_service.import_settings_tree(
        db, _tree(users=[{"username": "carol", "role": "nonexistent-role"}])
    )
    carol = await db.scalar(select(User).where(User.username == "carol"))
    assert carol.role == "user"
    assert any("nonexistent-role" in w for w in report.warnings)


async def test_import_refuses_admin_role_on_new_user(db):
    # A file must not be able to plant an admin (latent, activated later unflagged).
    report = await settings_import_service.import_settings_tree(
        db, _tree(users=[{"username": "mallory", "role": "admin"}])
    )
    mallory = await db.scalar(select(User).where(User.username == "mallory"))
    assert mallory.role == "user"  # refused, not admin
    assert mallory.is_active is False
    assert any("mallory" in w and "admin" in w for w in report.warnings)


async def test_import_cannot_promote_existing_user_to_admin(db):
    await _seed(db)
    db.add(User(username="dave", role="user", password_hash="h", is_active=True))
    await db.commit()
    await settings_import_service.import_settings_tree(
        db, _tree(users=[{"username": "dave", "role": "admin"}])
    )
    dave = await db.scalar(select(User).where(User.username == "dave"))
    assert dave.role == "user"  # import can't promote a live account to admin


async def test_import_cannot_demote_existing_admin(db):
    await _seed(db)  # alice is admin
    report = await settings_import_service.import_settings_tree(
        db, _tree(users=[{"username": "alice", "role": "user"}]),
    )
    alice = await db.scalar(select(User).where(User.username == "alice"))
    assert alice.role == "admin"  # import can't strip administrators
    assert any("alice" in w and "demote" in w for w in report.warnings)


async def test_import_skips_acting_admin(db):
    await _seed(db)
    await settings_import_service.import_settings_tree(
        db,
        _tree(users=[{"username": "alice", "role": "user"}]),
        acting_username="alice",
    )
    alice = await db.scalar(select(User).where(User.username == "alice"))
    assert alice.role == "admin"  # self not rewritten (no lockout)


async def test_import_org_and_role_upsert(db):
    await _seed(db)
    await settings_import_service.import_settings_tree(
        db,
        _tree(
            orgs=[{"id": "org-1", "name": {"en": "RiCDC v2"}, "website": "https://new.fr"}],
            roles=[{"name": "curator", "label": {"en": "Data Curator"}, "scope": "workspace", "permissions": []}],
        ),
    )
    org = await db.get(Organization, "org-1")
    assert org.name == {"en": "RiCDC v2"} and org.website == "https://new.fr"
    role = await db.scalar(select(Role).where(Role.name == "curator"))
    assert role.label == {"en": "Data Curator"}


async def test_import_new_role_never_system(db):
    await settings_import_service.import_settings_tree(
        db, _tree(roles=[{"name": "hacker", "label": {}, "isSystem": True, "permissions": []}])
    )
    role = await db.scalar(select(Role).where(Role.name == "hacker"))
    assert role.is_system is False  # import can't mint a system role


# --- An import never raises an account's rights ---------------------------


async def _role(db, name: str, permissions: list[str], *, scope="workspace", is_system=False) -> None:
    db.add(Role(name=name, label={"en": name}, scope=scope, is_system=is_system, permissions=permissions))
    await db.commit()


async def _permissions_of(db, name: str) -> list[str]:
    return (await db.scalar(select(Role).where(Role.name == name))).permissions


async def test_import_leaves_a_system_roles_permissions_and_scope_alone(db):
    await _role(db, "user", [], scope="global", is_system=True)
    report = await settings_import_service.import_settings_tree(
        db, _tree(roles=[{"name": "user", "label": {"en": "Base"}, "scope": "workspace", "permissions": ALL_PERMISSIONS}])
    )
    role = await db.scalar(select(Role).where(Role.name == "user"))
    assert role.permissions == []
    assert role.scope == "global"
    assert role.label == {"en": "Base"}
    assert any("user" in w for w in report.warnings)


async def test_import_never_creates_a_role_holding_global_permissions(db):
    report = await settings_import_service.import_settings_tree(
        db,
        _tree(roles=[{"name": "steward", "scope": "global", "permissions": ["users:write", "app-database:read", "cohorts:read"]}]),
    )
    role = await db.scalar(select(Role).where(Role.name == "steward"))
    assert role.permissions == ["cohorts:read"]
    assert role.scope == "workspace"
    assert any("steward" in w and "users:write" in w for w in report.warnings)


async def test_import_never_adds_permissions_to_a_local_role(db):
    await _role(db, "curator", ["cohorts:read", "cohorts:write"])
    report = await settings_import_service.import_settings_tree(
        db, _tree(roles=[{"name": "curator", "scope": "global", "permissions": ["cohorts:read", "projects:delete"]}])
    )
    role = await db.scalar(select(Role).where(Role.name == "curator"))
    assert role.permissions == ["cohorts:read"]
    assert role.scope == "workspace"
    assert any("curator" in w and "projects:delete" in w for w in report.warnings)


async def test_import_keeps_a_local_custom_roles_own_global_permission(db):
    await _role(db, "auditor", ["audit-log:read"], scope="global")
    await settings_import_service.import_settings_tree(db, _tree(roles=[{"name": "auditor", "scope": "global", "permissions": ["audit-log:read"]}]))
    assert await _permissions_of(db, "auditor") == ["audit-log:read"]


async def test_import_cannot_move_an_account_to_a_role_holding_more(db):
    await _role(db, "user", [], scope="global", is_system=True)
    await _role(db, "superuser", ["users:write"], scope="global")
    db.add(User(username="dave", role="user", password_hash="h", is_active=True))
    await db.commit()
    report = await settings_import_service.import_settings_tree(db, _tree(users=[{"username": "dave", "role": "superuser"}]))
    dave = await db.scalar(select(User).where(User.username == "dave"))
    assert dave.role == "user"
    assert any("dave" in w and "superuser" in w for w in report.warnings)


async def test_import_account_role_named_in_the_same_file_grants_nothing_global(db):
    await _role(db, "user", [], scope="global", is_system=True)
    db.add(User(username="dave", role="user", password_hash="h", is_active=True))
    await db.commit()
    await settings_import_service.import_settings_tree(
        db,
        _tree(
            roles=[{"name": "planted", "scope": "global", "permissions": GLOBAL_PERMISSIONS}],
            users=[{"username": "dave", "role": "planted"}, {"username": "erin", "role": "planted"}],
        ),
    )
    assert await _permissions_of(db, "planted") == []
    dave = await db.scalar(select(User).where(User.username == "dave"))
    assert dave.role in ("user", "planted")
    assert not await has_global_permission(db, dave, "users:write")


async def test_import_new_account_never_lands_on_a_role_holding_global_permissions(db):
    await _role(db, "superuser", ["users:write"], scope="global")
    report = await settings_import_service.import_settings_tree(db, _tree(users=[{"username": "erin", "role": "superuser"}]))
    erin = await db.scalar(select(User).where(User.username == "erin"))
    assert erin.role == "user"
    assert any("erin" in w and "superuser" in w for w in report.warnings)


async def test_import_can_move_an_account_to_a_role_holding_no_more(db):
    await _role(db, "user", [], scope="global", is_system=True)
    await _role(db, "reader", [], scope="global")
    await _role(db, "broad", ["audit-log:read"], scope="global")
    db.add(User(username="dave", role="broad", password_hash="h", is_active=True))
    await db.commit()
    report = await settings_import_service.import_settings_tree(db, _tree(users=[{"username": "dave", "role": "reader"}]))
    dave = await db.scalar(select(User).where(User.username == "dave"))
    assert dave.role == "reader"
    assert report.warnings == []
