from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


class SqlScriptCollection(Base, TimestampMixin):
    """A workspace-scoped collection of SQL scripts (metadata only; the scripts
    themselves are a file tree in SqlScriptFile)."""

    __tablename__ = "sql_script_collections"

    # Frontend keys collections by client-supplied UUID.
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    # Human-readable, URL-safe id set once at creation (folder name in exports).
    entity_id: Mapped[str | None] = mapped_column(String(255))
    name: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)  # LocalizedString
    description: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    default_data_source_id: Mapped[str | None] = mapped_column(String(36))
    git_remote_config: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Encrypted git access token (Fernet); kept out of git_remote_config so it's
    # never returned by the API. Mirrors DataSource.connection_secret.
    git_remote_secret: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str | None] = mapped_column(Text)
    created_by_details: Mapped[dict | None] = mapped_column(JSONB_or_JSON)


class SqlScriptFile(Base):
    """A node (file or folder) in a collection's script tree. SQL text is short
    and lives inline in `content` — no blob store needed."""

    __tablename__ = "sql_script_files"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    collection_id: Mapped[str] = mapped_column(
        ForeignKey("sql_script_collections.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(255))
    type: Mapped[str] = mapped_column(String(10))  # 'file' | 'folder'
    # Self-referential hierarchy; not an FK so orphaned children survive a parent
    # delete (the frontend re-parents them). Nullable = top-level node.
    parent_id: Mapped[str | None] = mapped_column(String(36))
    content: Mapped[str | None] = mapped_column(Text)
    order: Mapped[int] = mapped_column(Integer, default=0)
    data_source_id: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[str | None] = mapped_column(String(40))
