from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin, UUIDPKMixin


class AgentConversation(Base, UUIDPKMixin, TimestampMixin):
    """One chat thread between a user and an assistant surface.

    A prompt can carry clinical context, so a conversation is **private to its
    author**: every route filters on `user_id` in the query itself rather than
    trimming the response, and there is no route that lists another user's
    threads. Saving is also opt-out from the assistant's settings — nothing is
    written when the user turns it off.
    """

    __tablename__ = "agent_conversations"

    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    # Which page the thread belongs to, so the sidebar can show only the history
    # of the dashboard/cohort the user is looking at. Null for a workspace-wide
    # surface that isn't tied to one entity.
    project_uid: Mapped[str | None] = mapped_column(String(36), index=True)
    surface: Mapped[str] = mapped_column(String(40), default="dashboard")
    entity_id: Mapped[str | None] = mapped_column(String(36), index=True)

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(Text, default="")
    # Full turn list, as the UI replays it: role, content, tool calls, results.
    messages: Mapped[list] = mapped_column(JSONB_or_JSON, default=list)
