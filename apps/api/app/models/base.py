import json
import uuid
from datetime import datetime

from sqlalchemy import JSON, DateTime, MetaData, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TypeDecorator

# Deterministic constraint names so Alembic autogenerate and SQLite batch
# migrations can find and recreate constraints (SQLite auto-names them otherwise).
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s",
    "pk": "pk_%(table_name)s",
}

# JSONB on PostgreSQL (indexable, native operators), plain JSON on SQLite.
# Identical dict semantics in Python either way.
JSONB_or_JSON = JSON().with_variant(JSONB, "postgresql")


class LocalizedText(TypeDecorator):
    """A JSON column that tolerates legacy plain-string values on read.

    Multilingual fields store a LocalizedString dict ({"en": ..., "fr": ...}),
    but older data (and seed manifests) may hold a bare string. We serialize
    dicts to JSON on write and, on read, parse JSON when possible and otherwise
    return the raw string — so a legacy `"Demo Hospital"` never crashes decoding.
    Empty/NULL reads back as None.
    """

    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if isinstance(value, str):
            return value  # stored as-is; read side handles it
        return json.dumps(value)

    def process_result_value(self, value, dialect):
        if value is None or value == "":
            return None
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            return value


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class UUIDPKMixin:
    """String UUID primary key matching the frontend's client-generated ids.

    Accepts a client-supplied id (stable seed/round-trip) and falls back to a
    server-generated uuid4 when absent.
    """

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
