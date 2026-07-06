from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.project import Project
from app.models.role import Role
from app.models.user import User
from app.models.workspace_member import WorkspaceMember

ROLE_ORDER = {"viewer": 0, "editor": 1, "owner": 2}

# --- Permission catalogue -------------------------------------------------
# The set of (resource, action) pairs the app knows about. This is code-owned,
# not user-configurable: adding a resource/action is a code change. Roles pick
# from this catalogue. The UI reads it (GET /permissions) to render the matrix.
RESOURCES = [
    "workspaces",
    "projects",
    "wiki",
    "datasets",
    "dashboards",
    "databases",
    "cohorts",
    "concepts",
    "members",
    "organizations",
]
ACTIONS = ["read", "write", "delete"]

PERMISSIONS = [f"{r}:{a}" for r in RESOURCES for a in ACTIONS]

# Actions that a global admin manages instance-wide.
GLOBAL_RESOURCES = ["users", "roles", "settings"]
GLOBAL_PERMISSIONS = [f"{r}:{a}" for r in GLOBAL_RESOURCES for a in ACTIONS]

ALL_PERMISSIONS = PERMISSIONS + GLOBAL_PERMISSIONS


def _perms_for(actions_by_resource: dict[str, list[str]]) -> list[str]:
    return [f"{r}:{a}" for r, acts in actions_by_resource.items() for a in acts]


# --- Default system roles -------------------------------------------------
# Seeded on startup if absent. is_system=True → not deletable, permissions editable.
# The global "admin" role is a hard super-admin (bypasses the permission system
# entirely, see has_permission) so editing roles can never lock everyone out.
DEFAULT_ROLES = [
    {
        "name": "viewer",
        "label": {"en": "Viewer", "fr": "Lecteur"},
        "scope": "workspace",
        "permissions": [f"{r}:read" for r in RESOURCES],
    },
    {
        "name": "editor",
        "label": {"en": "Editor", "fr": "Éditeur"},
        "scope": "workspace",
        "permissions": [f"{r}:read" for r in RESOURCES]
        + [f"{r}:write" for r in RESOURCES],
    },
    {
        "name": "owner",
        "label": {"en": "Owner", "fr": "Propriétaire"},
        "scope": "workspace",
        "permissions": PERMISSIONS,  # every workspace action, including delete + members
    },
    {
        "name": "admin",
        "label": {"en": "Administrator", "fr": "Administrateur"},
        "scope": "global",
        "permissions": ALL_PERMISSIONS,
    },
    {
        "name": "user",
        "label": {"en": "User", "fr": "Utilisateur"},
        "scope": "global",
        "permissions": [],  # base account; access derives from workspace membership
    },
]


async def seed_default_roles(db: AsyncSession) -> None:
    """Create any missing system role. Existing roles are left untouched so
    admin edits to their permissions survive restarts."""
    for spec in DEFAULT_ROLES:
        existing = await db.scalar(select(Role).where(Role.name == spec["name"]))
        if existing is None:
            db.add(Role(is_system=True, **spec))
    await db.commit()


# --- Enforcement ----------------------------------------------------------


async def check_workspace_role(
    db: AsyncSession, workspace_id: str, user: User, min_role: str
) -> WorkspaceMember | None:
    """Enforce at least `min_role` on `workspace_id`; raise 403 otherwise.

    Callable from routes/services outside the dependency system. Global admins
    bypass the membership check.
    """
    if user.role == "admin":
        return await db.get(WorkspaceMember, (workspace_id, user.id))
    member = await db.get(WorkspaceMember, (workspace_id, user.id))
    if member is None or ROLE_ORDER.get(member.role, -1) < ROLE_ORDER.get(min_role, 99):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient workspace permissions",
        )
    return member


async def has_permission(
    db: AsyncSession, workspace_id: str, user: User, permission: str
) -> bool:
    """True if the user's role on `workspace_id` grants `permission`.

    Global admins always pass (hard super-admin). Otherwise the user's workspace
    member role is resolved to a Role row and its permission list is consulted.
    """
    if user.role == "admin":
        return True
    member = await db.get(WorkspaceMember, (workspace_id, user.id))
    if member is None:
        return False
    role = await db.scalar(select(Role).where(Role.name == member.role))
    if role is None:
        return False
    return permission in (role.permissions or [])


def require_workspace_role(min_role: str):
    """Dependency factory: require at least `min_role` on the path workspace.

    Global admins bypass the membership check. Returns the WorkspaceMember
    (None for admins who aren't members).
    """

    async def _dep(
        workspace_id: str,
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> WorkspaceMember | None:
        return await check_workspace_role(db, workspace_id, user, min_role)

    return _dep


def require_permission(permission: str):
    """Dependency factory: require `permission` on the path workspace."""

    async def _dep(
        workspace_id: str,
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> User:
        if not await has_permission(db, workspace_id, user, permission):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions",
            )
        return user

    return _dep


def require_project_role(min_role: str):
    """Require `min_role` on the workspace owning the path project.

    Project access derives from workspace membership. A project not yet assigned
    to a workspace is accessible to any authenticated user (legacy/unassigned).
    """

    async def _dep(
        project_uid: str,
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> Project:
        project = await db.get(Project, project_uid)
        if project is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Not found"
            )
        if project.workspace_id is not None:
            await check_workspace_role(db, project.workspace_id, user, min_role)
        return project

    return _dep
