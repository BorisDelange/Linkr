from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin

# Project roles reuse the workspace ladder, ordered weakest → strongest.
PROJECT_ROLES = ("viewer", "editor", "owner")


class ProjectMember(Base, TimestampMixin):
    """Per-project role override. Optional: a project with no row for a user
    falls back to the user's inherited workspace role. When a row exists it
    REPLACES the inherited role entirely — it can widen (editor→owner) or
    restrict (editor→viewer, or exclude via a role the caller lacks)."""

    __tablename__ = "project_members"

    project_uid: Mapped[str] = mapped_column(
        ForeignKey("projects.uid", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[str] = mapped_column(String(20))  # viewer | editor | owner
