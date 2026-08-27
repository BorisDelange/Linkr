from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


class SchemaPreset(Base, TimestampMixin):
    __tablename__ = "schema_presets"

    # Local primary key, uuid — like every other entity. The table's PK moved here
    # from preset_id in revision e6f7a8b9c0d1; the mapping has to agree with the
    # database or `db.get()` queries the wrong column and every lookup by id 404s.
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    # RETIRED identity — see docs/planning/schema-preset-identity-plan.md. It played
    # three roles at once (local PK, user-facing slug, cross-instance identity)
    # where every other entity splits them into id + entity_id + lineage_id. Kept
    # so rows and export trees written before the split stay readable.
    preset_id: Mapped[str | None] = mapped_column(String(36))
    # Human-readable, URL-safe id set once at creation (folder name in exports).
    entity_id: Mapped[str | None] = mapped_column(String(255))
    workspace_id: Mapped[str | None] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    mapping: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    readme: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Entity licence: {id, name?, text} — the text is snapshotted at pick time
    # so it travels with the export (LICENSE.md) independently of the picker.
    license: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Free-form labels, like every other badged entity. Missing here until now, so
    # a badge set in the UI was dropped on save in server mode — the client type
    # and the export both carried it, only the column was absent.
    badges: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    git_remote_config: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
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
    # export/import; a fork mints a new lineage_id and points parent_lineage_id at its
    # source. Same contract as SqlScriptCollection / DataCatalog / EtlPipeline.
    lineage_id: Mapped[str | None] = mapped_column(String(36))
    parent_lineage_id: Mapped[str | None] = mapped_column(String(36))
