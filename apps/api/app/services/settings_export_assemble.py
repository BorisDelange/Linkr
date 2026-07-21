"""Assemble the settings (account-level) versioning ZIP server-side.

Exports the instance's organizations + users + roles as a small JSON tree so a
fresh instance can re-import them (see settings_import_service). The caller picks
which entities to include; an unchecked entity is omitted from the tree entirely
(so it neither pushes nor shows as a deletion diff).

**Passwords are never exported.** ``users.json`` carries no password hash and no
``isActive`` flag — the "disabled until a password is set" rule is *derived* at
import time (no hash → disabled), not transported in the file.

Keys are camelCase to match the browser's entity-io format (the same files are
parsed client-side): the import path reads them regardless of who wrote the ZIP.
"""
import asyncio
import io
import json
import zipfile
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.organization import Organization
from app.models.role import Role
from app.models.user import User


@dataclass
class SettingsSelection:
    """Which account-level entities to include in the export ZIP."""

    organizations: bool = True
    users: bool = True
    roles: bool = True


def _iso(dt) -> str | None:
    """Creation date as an ISO string for the versioned file (kept as stable
    provenance). None-safe. updatedAt is deliberately never exported."""
    return dt.isoformat() if dt else None


def _org_dict(o: Organization) -> dict:
    # Full record minus volatile fields: NO updatedAt (churns on edit, re-stamped
    # on import). createdAt IS kept as provenance. Identity is the UUID id, kept
    # so import upserts in place across instances.
    return {
        "id": o.id,
        "name": o.name,
        "type": o.type,
        "location": o.location,
        "country": o.country,
        "website": o.website,
        "email": o.email,
        "customType": o.custom_type,
        "referenceId": o.reference_id,
        "customFields": o.custom_fields,
        "createdAt": _iso(o.created_at),
    }


def _user_dict(u: User) -> dict:
    # NO passwordHash, NO isActive, NO auth/session fields, NO updatedAt. Only the
    # profile a human would otherwise re-type by hand, plus createdAt provenance.
    return {
        "username": u.username,
        "email": u.email,
        "firstName": u.first_name,
        "lastName": u.last_name,
        "affiliation": u.affiliation,
        "profession": u.profession,
        "orcid": u.orcid,
        "role": u.role,
        "createdAt": _iso(u.created_at),
    }


def _role_dict(r: Role) -> dict:
    return {
        "name": r.name,
        "label": r.label,
        "scope": r.scope,
        "isSystem": r.is_system,
        "permissions": r.permissions,
        "createdAt": _iso(r.created_at),
    }


def _json(data: object) -> bytes:
    return json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8")


async def build_settings_tree(
    db: AsyncSession, selection: SettingsSelection
) -> dict[str, bytes]:
    """Assemble the settings export file tree. Deterministic ordering (by id /
    username / name) so the git diff is stable across exports."""
    tree: dict[str, bytes] = {}

    if selection.organizations:
        orgs = (await db.execute(select(Organization).order_by(Organization.id))).scalars().all()
        tree["organizations.json"] = _json([_org_dict(o) for o in orgs])

    if selection.users:
        users = (await db.execute(select(User).order_by(User.username))).scalars().all()
        tree["users.json"] = _json([_user_dict(u) for u in users])

    if selection.roles:
        roles = (await db.execute(select(Role).order_by(Role.name))).scalars().all()
        tree["roles.json"] = _json([_role_dict(r) for r in roles])

    return tree


def _zip_tree(tree: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path, content in tree.items():
            zf.writestr(path, content)
    return buf.getvalue()


async def assemble_settings_zip(
    db: AsyncSession, selection: SettingsSelection
) -> bytes:
    """Build the settings export ZIP bytes server-side (no client upload). Feeds
    the same git flow (status/diff/commit-push) the other scopes use."""
    tree = await build_settings_tree(db, selection)
    return await asyncio.to_thread(_zip_tree, tree)
