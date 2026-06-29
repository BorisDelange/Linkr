from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin

# Workspace roles, ordered weakest → strongest.
WORKSPACE_ROLES = ("viewer", "editor", "owner")


class WorkspaceMember(Base, TimestampMixin):
    __tablename__ = "workspace_members"

    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[str] = mapped_column(String(20))  # viewer | editor | owner

    workspace: Mapped["Workspace"] = relationship(back_populates="members")  # noqa: F821
