from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


class DataDictionary(Base, TimestampMixin):
    """A workspace's data dictionary: a set of concept sets (rows of
    `concept_sets` pointing here) with the unit conversions and recommended
    units that go with them, usually synced from a repository with the INDICATE
    layout (`concept_sets/`, `units/`)."""

    __tablename__ = "data_dictionaries"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(255), default="")
    # Where it syncs from; null for hand-imported concept sets.
    source_repo: Mapped[str | None] = mapped_column(Text)
    branch: Mapped[str | None] = mapped_column(String(255))
    # The commit last synced, so an update can say whether anything moved.
    commit: Mapped[str | None] = mapped_column(String(64))
    synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # `units/unit_conversions.json` / `units/recommended_units.json`, verbatim.
    unit_conversions: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    recommended_units: Mapped[list | None] = mapped_column(JSONB_or_JSON)
