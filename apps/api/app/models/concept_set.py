from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


class ConceptSet(Base, TimestampMixin):
    """A workspace-scoped concept set: an expression (items) plus resolved ids
    (a cache) and provenance metadata."""

    __tablename__ = "concept_sets"

    # Frontend keys concept sets by client-supplied UUID.
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(255), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    expression: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)  # { items: [...] }
    resolved_concept_ids: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    source_url: Mapped[str | None] = mapped_column(Text)
    unique_id: Mapped[str | None] = mapped_column(String(255))
    source_repo: Mapped[str | None] = mapped_column(String(255))
    category: Mapped[str | None] = mapped_column(String(255))
    subcategory: Mapped[str | None] = mapped_column(String(255))
    provenance: Mapped[str | None] = mapped_column(String(255))
    version: Mapped[str | None] = mapped_column(String(50))
    import_batch_id: Mapped[str | None] = mapped_column(String(36))
    translations: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
