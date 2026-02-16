import uuid
from datetime import datetime

from sqlalchemy import String, JSON, DateTime, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Dataset(Base):
    __tablename__ = "datasets"

    id: Mapped[int] = mapped_column(primary_key=True)
    uid: Mapped[str] = mapped_column(
        String(36), unique=True, default=lambda: str(uuid.uuid4())
    )
    name: Mapped[dict] = mapped_column(JSON)  # {"en": "...", "fr": "..."}
    source_type: Mapped[str] = mapped_column(String(50))  # omop, fhir, csv, database
    connection_config: Mapped[dict] = mapped_column(JSON, default=dict)
    omop_version: Mapped[str | None] = mapped_column(String(10))
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
