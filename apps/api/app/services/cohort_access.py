"""Who may touch a cohort: a project's cohort answers to the project's
`cohorts:*`, a database's to the workspace's `databases:*`. Shared by the routes
and by undo, which re-checks before reversing an agent's change."""
from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.permissions import check_project_permission, check_workspace_permission
from app.models.data_source import DataSource
from app.models.project import Project
from app.models.user import User

# A database's cohorts are part of the database: reading them is reading it,
# changing or deleting one is editing it (the `databases:*` workspace permission),
# where a project's cohorts answer to the project's own `cohorts:*`.
_DATABASE_PERMISSION = {
    "cohorts:read": "databases:read",
    "cohorts:write": "databases:write",
    "cohorts:delete": "databases:write",
}


async def require_project_access(
    db: AsyncSession, project_uid: str, user: User, permission: str
) -> None:
    """Cohort access derives from the owning project (workspace role inherited,
    with per-project override applied). Gated on the atomic `cohorts:*` permission."""
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    await check_project_permission(db, project, user, permission)


async def require_database_access(
    db: AsyncSession, data_source_id: str, user: User, permission: str
) -> None:
    source = await db.get(DataSource, data_source_id)
    if source is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Database not found")
    if source.workspace_id is not None:
        await check_workspace_permission(
            db, source.workspace_id, user, _DATABASE_PERMISSION[permission]
        )


async def require_owner_access(
    db: AsyncSession,
    project_uid: str | None,
    owner_data_source_id: str | None,
    user: User,
    permission: str,
) -> None:
    if project_uid:
        await require_project_access(db, project_uid, user, permission)
    elif owner_data_source_id:
        await require_database_access(db, owner_data_source_id, user, permission)
    else:
        # Unreachable for a stored row (the create refuses it); a cohort with no
        # owner answers to no permission, so it must not be served at all.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
