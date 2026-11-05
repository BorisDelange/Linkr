from sqlalchemy import BigInteger, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, PortableJSON


class ConceptProfile(Base):
    """A database's profile of one concept: exact, computed once, read by every
    view describing the concept — the database's Concepts tab, a mapping
    project's extraction — each filtering it through its own thresholds
    (`apps/web/src/lib/concept-profiles/profile-store.ts`, which owns the shape).

    Shared by everyone who opens the database, like its concept list.
    """

    __tablename__ = "concept_profiles"

    data_source_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("data_sources.id", ondelete="CASCADE"), primary_key=True,
    )
    dict_key: Mapped[str] = mapped_column(String(200), primary_key=True)
    concept_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    rows_count: Mapped[int] = mapped_column(BigInteger, default=0)
    patients_count: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # ",numeric,histogram," — matched with LIKE by the summary on every engine.
    sections: Mapped[str] = mapped_column(Text, default="")
    variant: Mapped[dict] = mapped_column(PortableJSON, default=dict)
    fingerprint: Mapped[str] = mapped_column(String(64), default="")
    computed_at: Mapped[str] = mapped_column(String(40))
    profile: Mapped[dict] = mapped_column(PortableJSON, default=dict)
