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
    # Badges for grouping/tagging (list of {id, label, color}).
    badges: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    readme: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Entity licence: {id, name?, text} — the text is snapshotted at pick time
    # so it travels with the export (LICENSE.md) independently of the picker.
    license: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    data_source_id: Mapped[str] = mapped_column(String(36))
    # Portable identity of the database above ({lineageId?, entityId?, label?}).
    # data_source_id is this instance's local UUID and means nothing elsewhere, so
    # this is what the export carries and the import resolves back to a local row.
    data_source_ref: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    dimensions: Mapped[list] = mapped_column(JSONB_or_JSON, default=list)
    anonymization: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    category_column: Mapped[str | None] = mapped_column(String(255))
    subcategory_column: Mapped[str | None] = mapped_column(String(255))
    period_config: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    status: Mapped[str] = mapped_column(String(20), default="draft")
    last_error: Mapped[str | None] = mapped_column(Text)
    last_computed_at: Mapped[str | None] = mapped_column(String(40))
    last_compute_duration_ms: Mapped[int | None] = mapped_column(Integer)
    # Period rows a paused computation has written; a resume picks up there.
    # NULL means no run is in flight (nothing computed, or the last one finished).
    computed_periods: Mapped[int | None] = mapped_column(Integer)
    dcat_ap_metadata: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    origin: Mapped[str] = mapped_column(String(10), default="user", server_default="user")
    # User-facing semver, portable across export/import (see Project.version).
    version: Mapped[str] = mapped_column(String(20), default="0.1.0", server_default="0.1.0")
    # Stable creator identity (name resolved live from the directory); created_by /
    # created_by_details are the display snapshot kept for cross-instance imports.
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_by: Mapped[str | None] = mapped_column(Text)
    created_by_details: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Frozen provenance snapshot of the origin organization (not a live link).
    organization: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Stable cross-instance identity (separate from the local PK). Preserved across
    # export/import; a fork mints a new lineage_id and points parent_lineage_id at its source.
    lineage_id: Mapped[str | None] = mapped_column(String(36))
    parent_lineage_id: Mapped[str | None] = mapped_column(String(36))
    git_remote_config: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
