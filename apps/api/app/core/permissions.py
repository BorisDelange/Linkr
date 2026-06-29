from fastapi import Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.user import User
from app.models.workspace_member import WorkspaceMember

ROLE_ORDER = {"viewer": 0, "editor": 1, "owner": 2}


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
        if user.role == "admin":
            return await db.get(WorkspaceMember, (workspace_id, user.id))
        member = await db.get(WorkspaceMember, (workspace_id, user.id))
        if member is None or ROLE_ORDER[member.role] < ROLE_ORDER[min_role]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient workspace permissions",
            )
        return member

    return _dep
