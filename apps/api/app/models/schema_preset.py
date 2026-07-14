from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


class SchemaPreset(Base, TimestampMixin):
    __tablename__ = "schema_presets"

    # Frontend keys presets by preset_id (client-supplied).
    preset_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    workspace_id: Mapped[str | None] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    mapping: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    git_remote_config: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Encrypted git access token (Fernet); kept out of git_remote_config so it's
    # never returned by the API. Mirrors DataSource.connection_secret.
    git_remote_secret: Mapped[str | None] = mapped_column(Text)
    # Stable creator identity (name resolved live from the directory); created_by /
    # created_by_details are the display snapshot kept for cross-instance imports.
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_by: Mapped[str | None] = mapped_column(Text)
    created_by_details: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
