from sqlalchemy import ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class EntityVisit(Base):
    """Per-user "last visited" timestamp for an entity, powering the recency order
    of the "recent" lists (workspaces, projects, mapping projects). One row per
    (user, entity_type, entity_id); recording a visit upserts `visited_at`."""

    __tablename__ = "entity_visits"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "entity_type", "entity_id", name="uq_entity_visits_user_entity"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    entity_type: Mapped[str] = mapped_column(String(30))  # workspace | project | mapping-project
    entity_id: Mapped[str] = mapped_column(String(36))
    # ISO-8601 UTC string, matching the frontend's client timestamps.
    visited_at: Mapped[str] = mapped_column(String(40))
