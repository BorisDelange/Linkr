from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base


class IdeConnection(Base):
    """A project's IDE database connection. `connection_config` holds host/port/
    database/username but NEVER the password/token — that is stripped and stored
    encrypted in `connection_secret` (Fernet), mirroring DataSource."""

    __tablename__ = "ide_connections"

    # Frontend keys connections by client-supplied UUID.
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_uid: Mapped[str] = mapped_column(
        ForeignKey("projects.uid", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(255), default="")
    source: Mapped[str] = mapped_column(String(20))  # IdeConnectionSource
    data_source_id: Mapped[str | None] = mapped_column(String(36))
    connection_config: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    # Encrypted password/token (Fernet). Never returned by the API. NULL if none.
    connection_secret: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str | None] = mapped_column(String(20))
    error_message: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str | None] = mapped_column(String(40))
