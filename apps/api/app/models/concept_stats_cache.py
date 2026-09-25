from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


class ConceptStatsCache(Base, TimestampMixin):
    """Per-(source, concept) cache of the detail-panel stats (row count, value
    distribution, histogram), shared by everyone who sees the database through
    the same principal.

    These are computed on demand the first time a concept is opened — a scan of
    the fact tables for that one concept — so once computed they are persisted and
    served to every user of the same principal who opens the concept, until the
    source changes.
    """

    __tablename__ = "concept_stats_caches"

    data_source_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("data_sources.id", ondelete="CASCADE"),
        primary_key=True,
    )
    concept_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Whose view of the database this was computed through: "" for a file
    # database (one answer for everyone), "user:<id>" for an external one, where
    # each user's own grants decide what the scan could see.
    principal: Mapped[str] = mapped_column(String(40), primary_key=True, default="", server_default="")
    # { rowCount, distribution?, histogram? } — the ConceptStats shape.
    stats: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
