from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, LocalizedText, TimestampMixin, UUIDPKMixin


class Organization(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "organizations"

    # Multilingual fields: LocalizedString dict, tolerant of legacy plain strings.
    name: Mapped[dict | str] = mapped_column(LocalizedText)
    type: Mapped[str | None] = mapped_column(String(50))
    location: Mapped[dict | str | None] = mapped_column(LocalizedText)
    country: Mapped[dict | str | None] = mapped_column(LocalizedText)
    website: Mapped[str | None] = mapped_column(String(500))
    email: Mapped[str | None] = mapped_column(String(255))
    custom_type: Mapped[dict | str | None] = mapped_column(LocalizedText)
    reference_id: Mapped[str | None] = mapped_column(String(255))
    custom_fields: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
