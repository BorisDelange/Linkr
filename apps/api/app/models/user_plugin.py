from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


class UserPlugin(Base, TimestampMixin):
    """A user-authored plugin. `files` maps filename → source code (inline, text).
    Always workspace-scoped: a plugin belongs to exactly one workspace, so its
    management is governed by that workspace's roles (no instance-wide plugins)."""

    __tablename__ = "user_plugins"

    # Frontend keys plugins by client-supplied UUID.
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    entity_id: Mapped[str | None] = mapped_column(String(255))
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    files: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)  # filename -> code
    git_remote_config: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Frozen origin-organization snapshot, carried across export/import.
    organization: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Creator provenance (see Project): created_by_id is the stable local identity;
    # created_by / created_by_details are the display snapshot for cross-instance
    # imports where the id has no local meaning.
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_by: Mapped[str | None] = mapped_column(Text)
    created_by_details: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
