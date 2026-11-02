from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


class ConceptStatsCache(Base, TimestampMixin):
    """Per-(source, concept) cache of the detail-panel stats (row count, value
    distribution, histogram), shared by everyone who opens the database.

    These are computed on demand the first time a concept is opened — a scan of
    the fact tables for that one concept — so once computed they are persisted and
    served to every user who opens the concept, until the source changes.
    """

    __tablename__ = "concept_stats_caches"

    data_source_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("data_sources.id", ondelete="CASCADE"),
        primary_key=True,
    )
    concept_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Always "": rows of external databases once held "user:<id>", each user's
    # own; the cache is now the source's (`concept_stats_cache_service`).
    principal: Mapped[str] = mapped_column(String(40), primary_key=True, default="", server_default="")
    # { rowCount, distribution?, histogram? } — the ConceptStats shape.
    stats: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
