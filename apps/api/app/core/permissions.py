from fastapi import Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.project import Project
from app.models.user import User
from app.models.workspace_member import WorkspaceMember

ROLE_ORDER = {"viewer": 0, "editor": 1, "owner": 2}


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
    if member is None or ROLE_ORDER[member.role] < ROLE_ORDER[min_role]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient workspace permissions",
        )
    return member


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
