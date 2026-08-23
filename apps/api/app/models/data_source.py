from sqlalchemy import Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, LocalizedText, TimestampMixin, UUIDPKMixin


class DataSource(Base, UUIDPKMixin, TimestampMixin):
    """A workspace-scoped database/FHIR source (the "base" entity).

    Metadata only. For imported file databases the bytes live in the blob store,
    referenced from `DataSourceFile.content_hash`. For external databases
    (Postgres, …) `connection_config` holds host/port/database/username — but
    never the password: it is stripped before write and supplied per-request.
    """

    __tablename__ = "data_sources"

    workspace_id: Mapped[str | None] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    # Human-readable, URL-safe id set once at creation (folder name in exports).
    entity_id: Mapped[str | None] = mapped_column(String(255))
    alias: Mapped[str] = mapped_column(String(255))
    # LocalizedString. LocalizedText (not JSONB_or_JSON) because these columns
    # already hold plain strings from before databases were multilingual: it
    # reads a legacy "Demo Hospital" back unchanged instead of failing to decode.
    name: Mapped[dict] = mapped_column(LocalizedText, default=dict)
    description: Mapped[dict | None] = mapped_column(LocalizedText)
    source_type: Mapped[str] = mapped_column(String(20))  # 'database' | 'fhir'
    connection_config: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    # Encrypted external-DB password (Fernet). Never returned by the API; only
    # decrypted server-side to open a connection. NULL for file/no-auth sources.
    connection_secret: Mapped[str | None] = mapped_column(Text)
    schema_mapping: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    status: Mapped[str] = mapped_column(String(20), default="configuring")
    stats: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    error_message: Mapped[str | None] = mapped_column(Text)
    is_vocabulary_reference: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="0"
    )
    badges: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    readme: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Entity licence: {id, name?, text} — the text is snapshotted at pick time
    # so it travels with the export (LICENSE.md) independently of the picker.
    license: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Git repo this database is linked to. The repo carries documentation and
    # metadata only: the export strips connection_config down to `engine` and
    # writes no rows, so the app is never the path by which data leaves.
    git_remote_config: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # User-facing semver, portable across export/import (see Project.version).
    version: Mapped[str] = mapped_column(String(20), default="0.1.0", server_default="0.1.0")
    # Frozen provenance snapshot of the origin organization (not a live link).
    organization: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Stable cross-instance identity (separate from the local PK). Preserved across
    # export/import; a fork mints a new lineage_id and points parent_lineage_id at its source.
    lineage_id: Mapped[str | None] = mapped_column(String(36))
    parent_lineage_id: Mapped[str | None] = mapped_column(String(36))
    origin: Mapped[str] = mapped_column(String(10), default="user", server_default="user")
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    # Creator provenance. created_by_id is the stable identity (name resolved live
    # from the directory); created_by / created_by_details are the display snapshot
    # kept for cross-instance imports where the id has no local meaning.
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_by: Mapped[str | None] = mapped_column(String(255))
    created_by_details: Mapped[dict | None] = mapped_column(JSONB_or_JSON)


class DataSourceFile(Base, UUIDPKMixin, TimestampMixin):
    """A file backing a data source, stored in the content-addressed blob store.

    The blob is keyed by `content_hash` (sha256), so re-importing the same OHDSI
    vocabulary into another source stores the bytes once — the client's
    `dedupRef` scheme is unnecessary server-side (the sha *is* the dedup key).
    """

    __tablename__ = "data_source_files"

    data_source_id: Mapped[str] = mapped_column(
        ForeignKey("data_sources.id", ondelete="CASCADE")
    )
    file_name: Mapped[str] = mapped_column(String(500))
    file_size: Mapped[int] = mapped_column(Integer, default=0)
    content_hash: Mapped[str] = mapped_column(String(64))
