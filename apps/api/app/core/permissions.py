from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.project import Project
from app.models.project_member import ProjectMember
from app.models.role import Role
from app.models.user import User
from app.models.workspace_member import WorkspaceMember

ROLE_ORDER = {"viewer": 0, "editor": 1, "owner": 2}

# --- Permission catalogue -------------------------------------------------
# The set of (resource, action) pairs the app knows about. This is code-owned,
# not user-configurable: adding a resource/action is a code change. Roles pick
# from this catalogue. The UI reads it (GET /permissions) to render the matrix.
#
# Actions are per-resource (not a uniform read/write/delete): most resources use
# read/write/delete, but some differ — "concepts" is read-only (browse only),
# "summary" has no delete, and "ide" adds "execute" (running R/Python/SQL, the
# app's only real server-side code execution). Order matters: the UI renders the
# matrix in catalogue order, grouped into Workspace / Project sections client-side.
RWD = ["read", "write", "delete"]

# Workspace-tier resources → their actions. Inherited by the workspace's projects;
# a project override (project_members) can refine per project. The client splits
# these into a "Workspace" section and a "Project" section for display.
WORKSPACE_CATALOGUE: dict[str, list[str]] = {
    # Workspace section (things that make up a workspace).
    # Manage THIS workspace: edit its settings (write) / delete it (delete). Note
    # the distinct name from the global "workspaces" resource (which gates
    # CREATING a workspace) — they must not collide as "resource:action" strings.
    "workspace-settings": RWD,
    "workspace-members": RWD,
    "workspace-summary": ["read", "write"],  # workspace home: overview + README
    "projects": RWD,
    "wiki": RWD,
    "plugins": RWD,
    "schemas": RWD,
    "databases": RWD,  # workspace owns the DB connections
    "concept-mapping": RWD,
    "sql-scripts": RWD,
    "data-quality": RWD,
    "catalog": RWD,
    "etl": RWD,
    # Project section (things scoped to a single project).
    # Manage THIS project: edit its settings (write) / delete it (delete). Mirrors
    # workspace-settings; distinct from the workspace-tier "projects" (create/list).
    "project-settings": RWD,
    "project-members": RWD,
    "project-summary": ["read", "write"],  # README + tasks; nothing to "delete"
    "ide": ["read", "write", "delete", "execute"],  # execute = run R/Python/SQL
    "pipeline": RWD,
    "project-databases": ["read", "write"],  # link/unlink a workspace source
    "concepts": ["read"],  # browse the source's concept dictionary (read-only)
    "cohorts": RWD,
    "patient-data": RWD,
    "datasets": RWD,
    "dashboards": RWD,
    "reports": RWD,  # stub page ("coming soon") — reserved so roles can pre-grant
}

RESOURCES = list(WORKSPACE_CATALOGUE.keys())
PERMISSIONS = [f"{r}:{a}" for r, acts in WORKSPACE_CATALOGUE.items() for a in acts]

# Global-tier resources → actions. Instance-wide management (Home / Settings).
GLOBAL_CATALOGUE: dict[str, list[str]] = {
    "users": RWD,
    "roles": RWD,
    # Organizations are an instance-wide directory (Settings → Organizations),
    # shared across workspaces — so they're gated globally, not per workspace.
    "organizations": RWD,
    # Read-only SQL against the app's OWN database (Settings → Application
    # database). Holds every table incl. password hashes, so it's admin-tier.
    "app-database": RWD,
    # Creating a workspace (from Home). WRITE-only: editing/deleting a workspace is
    # done via workspace membership (owner → workspace-settings) or the
    # all-workspaces super-grant. "workspaces:write" (global, = create) and
    # "workspace-settings:write" (workspace, = edit) deliberately mean different
    # things and never collide as strings. Placed next to "all-workspaces" since
    # both concern workspaces at the instance level.
    "workspaces": ["write"],
    # Cross-cutting grants: a global role holding these gets the corresponding
    # workspace-tier access on EVERY workspace/project without being a member
    # (like admin, but configurable). "all-workspaces:X" satisfies the
    # workspace-tier "workspaces:X" check on any workspace; "all-projects:X"
    # satisfies any workspace-tier check on any project. See global_grant_role.
    "all-workspaces": RWD,
    "all-projects": RWD,
}
GLOBAL_RESOURCES = list(GLOBAL_CATALOGUE.keys())
GLOBAL_PERMISSIONS = [f"{r}:{a}" for r, acts in GLOBAL_CATALOGUE.items() for a in acts]

ALL_PERMISSIONS = PERMISSIONS + GLOBAL_PERMISSIONS

# Backwards-compatible action list (uniform triple). Some callers still import it;
# the catalogue itself is now per-resource via WORKSPACE_CATALOGUE/GLOBAL_CATALOGUE.
ACTIONS = RWD


def _perms_for(actions_by_resource: dict[str, list[str]]) -> list[str]:
    return [f"{r}:{a}" for r, acts in actions_by_resource.items() for a in acts]


def _actions_up_to(action: str) -> set[str]:
    """Every action a role holding `action` implies, by the read⊂write⊂delete
    ladder, plus "execute" once you can write. Used to build default roles."""
    ladder = {"read": {"read"}, "write": {"read", "write", "execute"}, "delete": {"read", "write", "delete", "execute"}}
    return ladder.get(action, {action})


def _catalogue_perms(max_action: str) -> list[str]:
    """Workspace permissions a default role gets: for each resource, every one of
    its catalogue actions that is implied by `max_action`."""
    allowed = _actions_up_to(max_action)
    return [
        f"{r}:{a}"
        for r, acts in WORKSPACE_CATALOGUE.items()
        for a in acts
        if a in allowed
    ]


# --- Default system roles -------------------------------------------------
# Seeded on startup if absent. is_system=True → not deletable, permissions editable.
# The global "admin" role is a hard super-admin (bypasses the permission system
# entirely, see has_permission) so editing roles can never lock everyone out.
DEFAULT_ROLES = [
    {
        "name": "viewer",
        "label": {"en": "Viewer", "fr": "Lecteur"},
        "scope": "workspace",
        "permissions": _catalogue_perms("read"),
    },
    {
        "name": "editor",
        "label": {"en": "Editor", "fr": "Éditeur"},
        "scope": "workspace",
        "permissions": _catalogue_perms("write"),  # incl. ide:execute
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

# A global "all-*" grant of a given action confers this workspace-tier role rank.
_GRANT_ACTION_TO_ROLE = {"read": "viewer", "write": "editor", "delete": "owner"}


async def global_grant_role(db: AsyncSession, user: User, resource: str) -> str | None:
    """The workspace-tier role a user's GLOBAL role confers everywhere via an
    "all-workspaces"/"all-projects" grant, or None. The highest granted action
    wins (delete > write > read). Admins get "owner"."""
    if user.role == "admin":
        return "owner"
    role = await db.scalar(select(Role).where(Role.name == user.role))
    if role is None:
        return None
    perms = role.permissions or []
    best = None
    for action in ("delete", "write", "read"):
        if f"{resource}:{action}" in perms:
            best = _GRANT_ACTION_TO_ROLE[action]
            break
    return best


async def effective_workspace_role(
    db: AsyncSession, workspace_id: str, user: User
) -> str | None:
    """The user's resolved role on `workspace_id` (membership widened by any
    global "all-workspaces" grant). admin → "owner". None if no access."""
    if user.role == "admin":
        return "owner"
    member = await db.get(WorkspaceMember, (workspace_id, user.id))
    member_rank = ROLE_ORDER.get(member.role, -1) if member is not None else -1
    granted = await global_grant_role(db, user, "all-workspaces")
    best = max(member_rank, ROLE_ORDER.get(granted, -1) if granted else -1)
    if best < 0:
        return None
    return next(name for name, rank in ROLE_ORDER.items() if rank == best)


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
    member_rank = ROLE_ORDER.get(member.role, -1) if member is not None else -1
    granted = await global_grant_role(db, user, "all-workspaces")
    effective_rank = max(member_rank, ROLE_ORDER.get(granted, -1) if granted else -1)
    if effective_rank < ROLE_ORDER.get(min_role, 99):
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
    if member is not None:
        role = await db.scalar(select(Role).where(Role.name == member.role))
        if role is not None and permission in (role.permissions or []):
            return True
    granted = await global_grant_role(db, user, "all-workspaces")
    if granted is not None:
        return await _role_grants(db, granted, permission)
    return False


async def effective_project_role(
    db: AsyncSession, project: Project, user: User
) -> str | None:
    """The user's resolved role on `project` across the three dimensions.

    admin (global)          → always "owner"
    project override        → replaces the inherited role (widen, restrict, or
                              "none" = access removed even to a workspace member)
    else inherited          → the user's workspace role on the project's workspace
    else (no workspace)     → "owner" for a legacy/unassigned project (any user)

    Returns None when the user has no access at all.
    """
    if user.role == "admin":
        return "owner"

    # A cross-cutting global "all-projects" grant applies to every project (like
    # admin, but configurable). It widens access: the highest rank wins, so it
    # can lift a workspace member but never demotes an explicit stronger role.
    granted = await global_grant_role(db, user, "all-projects")

    def _widen(role: str | None) -> str | None:
        ranks = [ROLE_ORDER[r] for r in (role, granted) if r in ROLE_ORDER]
        if not ranks:
            return None
        best = max(ranks)
        return next(name for name, rank in ROLE_ORDER.items() if rank == best)

    override = await db.get(ProjectMember, (project.uid, user.id))
    if override is not None:
        # "none" is an explicit "hide this project from this member" override,
        # but a global all-projects grant still confers cross-cutting access.
        base = None if override.role == "none" else override.role
        return _widen(base)
    if project.workspace_id is None:
        # Unassigned project: no membership model applies, open to any user.
        return "owner"
    member = await db.get(WorkspaceMember, (project.workspace_id, user.id))
    return _widen(member.role if member is not None else None)


async def check_project_role(
    db: AsyncSession, project: Project, user: User, min_role: str
) -> str:
    """Enforce at least `min_role` on `project` (3-dimension resolution); raise
    403 otherwise. Returns the effective role."""
    role = await effective_project_role(db, project, user)
    if role is None or ROLE_ORDER.get(role, -1) < ROLE_ORDER.get(min_role, 99):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient project permissions",
        )
    return role


async def _role_grants(db: AsyncSession, role_name: str, permission: str) -> bool:
    role = await db.scalar(select(Role).where(Role.name == role_name))
    return role is not None and permission in (role.permissions or [])


async def _role_permissions(db: AsyncSession, role_name: str) -> list[str]:
    role = await db.scalar(select(Role).where(Role.name == role_name))
    return list(role.permissions or []) if role is not None else []


async def effective_workspace_permissions(
    db: AsyncSession, workspace_id: str, user: User
) -> list[str]:
    """The flat permission list the user effectively holds on `workspace_id`, for
    UI gating (honours custom roles). admin → every permission. Otherwise the
    permissions of the effective role (membership widened by any all-workspaces
    grant); a global role's OWN permissions (e.g. workspaces:write) are merged in
    so instance-wide grants show up too."""
    if user.role == "admin":
        return list(ALL_PERMISSIONS)
    role = await effective_workspace_role(db, workspace_id, user)
    perms = set(await _role_permissions(db, role)) if role else set()
    perms |= set(await _role_permissions(db, user.role))  # global-tier grants
    return sorted(perms)


async def effective_project_permissions(
    db: AsyncSession, project: Project, user: User
) -> list[str]:
    """The flat permission list the user effectively holds on `project`, for UI
    gating. admin → every permission; else the effective (override > inherited,
    widened by all-projects) role's permissions + the user's global-tier grants."""
    if user.role == "admin":
        return list(ALL_PERMISSIONS)
    role = await effective_project_role(db, project, user)
    perms = set(await _role_permissions(db, role)) if role else set()
    perms |= set(await _role_permissions(db, user.role))  # global-tier grants
    return sorted(perms)


async def has_project_permission(
    db: AsyncSession, project: Project, user: User, permission: str
) -> bool:
    """True if the user's effective role on `project` grants `permission`.

    Resolves the role across the three dimensions (override > inherited) and then
    checks that role's permission list — so a per-project override changes not
    just the rank but the granted permissions too. Global admins always pass."""
    if user.role == "admin":
        return True
    role = await effective_project_role(db, project, user)
    if role is None:
        return False
    return await _role_grants(db, role, permission)


def require_global_permission(permission: str):
    """Dependency factory: require a global-tier `permission` (e.g.
    "app-database:read"). The user's global role is consulted; admins pass."""

    async def _dep(
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> User:
        if user.role == "admin" or await _role_grants(db, user.role, permission):
            return user
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient permissions",
        )

    return _dep


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
    """Require `min_role` on the path project (3-dimension resolution).

    Access resolves as: global admin → owner; else a per-project override
    (project_members) if present; else the inherited workspace role; else, for a
    project with no workspace, open to any authenticated user (legacy/unassigned).
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
        await check_project_role(db, project, user, min_role)
        return project

    return _dep
