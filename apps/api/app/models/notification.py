from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, JSONB_or_JSON, LocalizedText, TimestampMixin, UUIDPKMixin


class Notification(Base, UUIDPKMixin, TimestampMixin):
    """A change made to an entity by an external client (an agent over MCP), shown
    in the header's notification centre of the user it acted for.

    Persisted, not only pushed: a write made while the tab was closed must still
    be there when the user comes back. Writes made from the app's own UI are not
    recorded — the user saw them happen.
    """

    __tablename__ = "notifications"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    # Which client made the change, from the X-Linkr-Client header ('mcp', …).
    source: Mapped[str] = mapped_column(String(32))
    action: Mapped[str] = mapped_column(String(16))  # created | updated | deleted
    entity_type: Mapped[str] = mapped_column(String(32))  # cohort, …
    entity_id: Mapped[str] = mapped_column(String(64))
    project_uid: Mapped[str | None] = mapped_column(String(36))
    # The entity's name at the time, so a deleted one still reads as something.
    label: Mapped[dict] = mapped_column(LocalizedText, default=dict)
    # What changed inside the entity, when not the entity itself:
    # {"part": "widget" | "tab", "action": ..., "name": LocalizedString}.
    detail: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # How to reverse the change: {"kind", "op": delete|restore|recreate, "id",
    # "snapshot"?} (see undo_service). NULL when it cannot be undone.
    undo: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    undone_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
