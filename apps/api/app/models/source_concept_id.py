from sqlalchemy import BigInteger, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class SourceConceptIdRange(Base):
    """A workspace's allocation range for a given badge. Composite natural key
    (workspace_id, badge_label) — no synthetic id (mirrors the frontend)."""

    __tablename__ = "source_concept_id_ranges"

    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True
    )
    badge_label: Mapped[str] = mapped_column(String(255), primary_key=True)
    range_start: Mapped[int] = mapped_column(BigInteger)
    range_end: Mapped[int] = mapped_column(BigInteger)
    next_id: Mapped[int] = mapped_column(BigInteger)
    total_concepts: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[str | None] = mapped_column(String(40))
    updated_at: Mapped[str | None] = mapped_column(String(40))


class SourceConceptIdEntry(Base):
    """One assigned source-concept id, keyed by the frontend's composite string
    id `${workspaceId}__${badgeLabel}__${vocabularyId}__${conceptCode}`. No
    updatedAt (entries are immutable once assigned)."""

    __tablename__ = "source_concept_id_entries"

    id: Mapped[str] = mapped_column(String(512), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    badge_label: Mapped[str] = mapped_column(String(255))
    vocabulary_id: Mapped[str] = mapped_column(String(255))
    concept_code: Mapped[str] = mapped_column(String(255))
    source_concept_id: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[str | None] = mapped_column(String(40))
