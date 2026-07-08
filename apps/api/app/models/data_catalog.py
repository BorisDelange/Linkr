from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


class DataCatalog(Base, TimestampMixin):
    """A workspace-scoped data catalog: dimension/anonymization config + DCAT-AP
    metadata. Computed results are a separate cache (not persisted here)."""

    __tablename__ = "data_catalogs"

    # Frontend keys catalogs by client-supplied UUID.
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    entity_id: Mapped[str | None] = mapped_column(String(255))
    name: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)  # LocalizedString
    description: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    data_source_id: Mapped[str] = mapped_column(String(36))
    dimensions: Mapped[list] = mapped_column(JSONB_or_JSON, default=list)
    anonymization: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    category_column: Mapped[str | None] = mapped_column(String(255))
    subcategory_column: Mapped[str | None] = mapped_column(String(255))
    period_config: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    status: Mapped[str] = mapped_column(String(20), default="draft")
    last_error: Mapped[str | None] = mapped_column(Text)
    last_computed_at: Mapped[str | None] = mapped_column(String(40))
    last_compute_duration_ms: Mapped[int | None] = mapped_column(Integer)
    dcat_ap_metadata: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    origin: Mapped[str] = mapped_column(String(10), default="user", server_default="user")
    created_by: Mapped[str | None] = mapped_column(Text)
    created_by_details: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
