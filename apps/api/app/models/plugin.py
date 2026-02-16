import uuid
from datetime import datetime

from sqlalchemy import String, JSON, DateTime, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Plugin(Base):
    __tablename__ = "plugins"

    id: Mapped[int] = mapped_column(primary_key=True)
    uid: Mapped[str] = mapped_column(
        String(36), unique=True, default=lambda: str(uuid.uuid4())
    )
    name: Mapped[dict] = mapped_column(JSON)  # {"en": "...", "fr": "..."}
    description: Mapped[dict] = mapped_column(JSON, default=dict)
    plugin_type: Mapped[str] = mapped_column(String(50))  # patient_level, aggregated, both
    version: Mapped[str] = mapped_column(String(50), default="0.0.1")
    manifest: Mapped[dict] = mapped_column(JSON, default=dict)
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
