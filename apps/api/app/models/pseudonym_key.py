from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class PseudonymKey(Base, TimestampMixin):
    """The HMAC key a pseudonymised derivation drew its pseudonyms with, kept so
    a rebuild draws the same ones and a re-identification stays possible.

    One per derivation: `id` is the database written, or `<database>.<schema>`
    for a SQL schema. `sealed_key` is sealed to that id (crypto.encrypt), apart
    from the derived data as the CNIL referential asks of correspondence means
    (SEC-LOG-4), and never returned by the API.
    """

    __tablename__ = "pseudonym_keys"

    id: Mapped[str] = mapped_column(String(160), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String(36), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    sealed_key: Mapped[str] = mapped_column(Text)
    created_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
