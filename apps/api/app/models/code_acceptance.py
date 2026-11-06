from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class CodeAcceptance(Base):
    """A user having accepted one exact text of code that the app runs on its own
    (widget, analysis, plugin). See `code_acceptance_service`."""

    __tablename__ = "code_acceptances"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    # SHA-256 of the code: nothing else in the table reads it, and a digest never
    # goes stale in a copy of the code a later delete would have to find.
    digest: Mapped[str] = mapped_column(String(64), primary_key=True)
    accepted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
