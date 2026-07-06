from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin, UUIDPKMixin


class Organization(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "organizations"

    # Multilingual fields stored as JSON LocalizedString ({"en": ..., "fr": ...}).
    # Legacy plain strings remain valid JSON and are read transparently client-side.
    name: Mapped[dict | str] = mapped_column(JSONB_or_JSON)
    type: Mapped[str | None] = mapped_column(String(50))
    location: Mapped[dict | str | None] = mapped_column(JSONB_or_JSON)
    country: Mapped[dict | str | None] = mapped_column(JSONB_or_JSON)
    website: Mapped[str | None] = mapped_column(String(500))
    email: Mapped[str | None] = mapped_column(String(255))
    custom_type: Mapped[dict | str | None] = mapped_column(JSONB_or_JSON)
    reference_id: Mapped[str | None] = mapped_column(String(255))
    custom_fields: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
