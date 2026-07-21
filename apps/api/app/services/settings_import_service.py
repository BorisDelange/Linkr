"""Import the settings (account-level) versioning tree: organizations, users, roles.

Mirrors settings_export_assemble. Upsert by stable identity:
- organizations by UUID ``id``
- roles by ``name`` (system roles matched by name, never duplicated)
- users by ``username``

**Passwords are never in the tree.** A newly-imported user lands DISABLED
(``is_active = False``, no ``password_hash``) and must be given a password + enabled
before login. An *existing* user's ``password_hash`` and ``is_active`` are left
untouched — re-importing never locks anyone out and never disables an active account.

Only the files present in the tree are applied; the caller's checkbox selection
decides which files the export wrote, so "import only what's checked" falls out for
free (an absent file is simply skipped).
"""
import json
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.permissions import ALL_PERMISSIONS
from app.models.organization import Organization
from app.models.role import Role
from app.models.user import User


@dataclass
class SettingsImportReport:
    orgs_created: int = 0
    orgs_updated: int = 0
    roles_created: int = 0
    roles_updated: int = 0
    users_created: int = 0
    users_updated: int = 0
    # username → reason (skipped self / would-drop-last-admin / unknown-role-fallback)
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "orgsCreated": self.orgs_created,
            "orgsUpdated": self.orgs_updated,
            "rolesCreated": self.roles_created,
            "rolesUpdated": self.roles_updated,
            "usersCreated": self.users_created,
            "usersUpdated": self.users_updated,
            "warnings": self.warnings,
        }


def _parse(tree: dict[str, bytes], path: str) -> list[dict]:
    raw = tree.get(path)
    if raw is None:
        return []
    data = json.loads(raw.decode("utf-8"))
    return data if isinstance(data, list) else []


def _created_at_kwarg(row: dict) -> dict:
    """`{"created_at": <datetime>}` when the row carries a parseable createdAt,
    else `{}` so the column's server_default stamps now. Only applied when a
    record is CREATED — an existing record keeps its own creation date."""
    raw = row.get("createdAt")
    if not raw:
        return {}
    try:
        return {"created_at": datetime.fromisoformat(raw)}
    except (ValueError, TypeError):
        return {}


async def _import_orgs(db: AsyncSession, rows: list[dict], report: SettingsImportReport) -> None:
    for row in rows:
        oid = row.get("id")
        if not oid:
            continue
        existing = await db.get(Organization, oid)
        fields = dict(
            name=row.get("name") or "",
            type=row.get("type"),
            location=row.get("location"),
            country=row.get("country"),
            website=row.get("website"),
            email=row.get("email"),
            custom_type=row.get("customType"),
            reference_id=row.get("referenceId"),
            custom_fields=row.get("customFields"),
        )
        if existing is None:
            db.add(Organization(id=oid, **fields, **_created_at_kwarg(row)))
            report.orgs_created += 1
        else:
            for k, v in fields.items():
                setattr(existing, k, v)
            report.orgs_updated += 1


async def _import_roles(db: AsyncSession, rows: list[dict], report: SettingsImportReport) -> None:
    for row in rows:
        name = row.get("name")
        if not name:
            continue
        perms = [p for p in (row.get("permissions") or []) if p in ALL_PERMISSIONS]
        existing = await db.scalar(select(Role).where(Role.name == name))
        if existing is None:
            db.add(
                Role(
                    name=name,
                    label=row.get("label") or {},
                    scope=row.get("scope") or "workspace",
                    # An imported role is never granted system status; only the
                    # code-seeded roles are system, matched by name below.
                    is_system=False,
                    permissions=perms,
                    **_created_at_kwarg(row),
                )
            )
            report.roles_created += 1
        else:
            # System roles: keep is_system + name; only label/permissions/scope update.
            existing.label = row.get("label") or existing.label
            existing.scope = row.get("scope") or existing.scope
            existing.permissions = perms
            report.roles_updated += 1


async def _known_role_names(db: AsyncSession) -> set[str]:
    rows = (await db.execute(select(Role.name))).scalars().all()
    return set(rows)


async def _import_users(
    db: AsyncSession,
    rows: list[dict],
    report: SettingsImportReport,
    acting_username: str | None,
) -> None:
    role_names = await _known_role_names(db)
    for row in rows:
        username = row.get("username")
        if not username:
            continue
        # Never rewrite the acting admin's own account from a file (avoid self-lockout).
        if acting_username and username == acting_username:
            report.warnings.append(f"{username}: skipped (own account)")
            continue

        role = row.get("role") or "user"
        # 'admin' is the hardcoded global superuser (not a Role row). An imported
        # file must NEVER grant it — on a new account it would plant a latent admin
        # (activated later via the routine enable flow, unflagged), on an existing
        # active account it would silently promote (bypassing the user_service
        # guards, which this path doesn't traverse). Refuse it → 'user'.
        if role == "admin":
            report.warnings.append(f"{username}: refused imported 'admin' role → 'user'")
            role = "user"
        elif role not in role_names:
            report.warnings.append(f"{username}: unknown role '{role}' → 'user'")
            role = "user"

        profile = dict(
            email=row.get("email"),
            first_name=row.get("firstName"),
            last_name=row.get("lastName"),
            affiliation=row.get("affiliation"),
            profession=row.get("profession"),
            orcid=row.get("orcid"),
            role=role,
        )

        existing = await db.scalar(select(User).where(User.username == username))
        if existing is None:
            # New account: no password → disabled until an admin sets one.
            db.add(User(username=username, password_hash=None, is_active=False, **profile, **_created_at_kwarg(row)))
            report.users_created += 1
        else:
            # Importing never changes a local account's admin status in EITHER
            # direction: 'admin' is refused above (no promotion), and a locally
            # existing admin keeps admin here (no demotion — a file must not be
            # able to strip administrators, which also can't lock out the last one).
            if existing.role == "admin":
                if role != "admin":
                    report.warnings.append(f"{username}: kept admin (import can't demote)")
                profile["role"] = "admin"
            # Update profile only; never touch password_hash or is_active.
            for k, v in profile.items():
                setattr(existing, k, v)
            report.users_updated += 1


async def import_settings_tree(
    db: AsyncSession,
    tree: dict[str, bytes],
    acting_username: str | None = None,
) -> SettingsImportReport:
    """Apply the settings tree to the DB. Orgs and roles first so imported users can
    reference imported roles."""
    report = SettingsImportReport()
    await _import_orgs(db, _parse(tree, "organizations.json"), report)
    await _import_roles(db, _parse(tree, "roles.json"), report)
    # Roles must be flushed before user role-validation reads them back.
    await db.flush()
    await _import_users(db, _parse(tree, "users.json"), report, acting_username)
    await db.commit()
    return report
