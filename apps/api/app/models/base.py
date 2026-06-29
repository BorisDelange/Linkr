import uuid
from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, MetaData, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, declared_attr, mapped_column

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


class OwnershipMixin:
    @declared_attr
    def owner_id(cls) -> Mapped[int | None]:
        return mapped_column(ForeignKey("users.id"))

    @declared_attr
    def created_by(cls) -> Mapped[int | None]:
        return mapped_column(ForeignKey("users.id"))
