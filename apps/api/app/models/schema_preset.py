from sqlalchemy import ForeignKey, String
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
