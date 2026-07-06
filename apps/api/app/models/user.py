from datetime import datetime

from sqlalchemy import JSON, DateTime, String, func
from sqlalchemy.sql import expression
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    email: Mapped[str | None] = mapped_column(String(255))
    first_name: Mapped[str | None] = mapped_column(String(255))
    last_name: Mapped[str | None] = mapped_column(String(255))
    affiliation: Mapped[str | None] = mapped_column(String(255))
    profession: Mapped[str | None] = mapped_column(String(255))
    orcid: Mapped[str | None] = mapped_column(String(255))
    # Nullable: LDAP/SSO users authenticate against an external directory.
    password_hash: Mapped[str | None] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(50), default="user")
    is_active: Mapped[bool] = mapped_column(default=True, server_default=expression.true())
    # SSO/LDAP readiness: provider + external directory identifier.
    auth_provider: Mapped[str] = mapped_column(
        String(20), default="local", server_default="local"
    )
    external_id: Mapped[str | None] = mapped_column(String(255), index=True)
    last_login: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    preferences: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
