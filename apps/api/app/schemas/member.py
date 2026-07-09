from datetime import datetime

from app.schemas.base import CamelModel


class MemberUser(CamelModel):
    """The user side of a membership row, for rendering the members list."""

    id: int
    username: str
    email: str | None = None


class WorkspaceMemberResponse(CamelModel):
    workspace_id: str
    user_id: int
    role: str
    user: MemberUser | None = None
    created_at: datetime | None = None


class WorkspaceMemberWrite(CamelModel):
    """Add or change a workspace member's role. Identify the user by id or by
    username (username lets an owner add someone without listing every user,
    which is admin-only)."""

    user_id: int | None = None
    username: str | None = None
    role: str  # viewer | editor | owner


class ProjectMemberResponse(CamelModel):
    project_uid: str
    user_id: int
    role: str  # the explicit override role
    user: MemberUser | None = None
    created_at: datetime | None = None


class ProjectMemberWrite(CamelModel):
    """Set (or update) a per-project role override for a user, by id or username."""

    user_id: int | None = None
    username: str | None = None
    role: str  # viewer | editor | owner
