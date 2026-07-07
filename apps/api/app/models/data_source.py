from sqlalchemy import Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin, UUIDPKMixin


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
    alias: Mapped[str] = mapped_column(String(255))
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="", server_default="")
    source_type: Mapped[str] = mapped_column(String(20))  # 'database' | 'fhir'
    connection_config: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    schema_mapping: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    status: Mapped[str] = mapped_column(String(20), default="configuring")
    stats: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    error_message: Mapped[str | None] = mapped_column(Text)
    is_vocabulary_reference: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="0"
    )
    origin: Mapped[str] = mapped_column(String(10), default="user", server_default="user")
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_by: Mapped[str | None] = mapped_column(String(255))


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
