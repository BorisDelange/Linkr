from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class DatabaseCredential(Base, TimestampMixin):
    """A user's own login to one external database, the only way Linkr reaches
    it: there is no shared account. Keyed by (user, database), not by host — two
    databases on one server often need two accounts.

    `secret` is sealed to (user, database, host, port, database name) — see
    database_credential_service.secret_context — so it neither opens for another
    user nor survives the database being pointed elsewhere. Never returned by
    the API.
    """

    __tablename__ = "database_credentials"
    __table_args__ = (
        UniqueConstraint("user_id", "data_source_id", name="uq_database_credential_user_source"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    data_source_id: Mapped[str] = mapped_column(
        ForeignKey("data_sources.id", ondelete="CASCADE"), index=True
    )
    username: Mapped[str] = mapped_column(String(255))
    secret: Mapped[str] = mapped_column(Text)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
