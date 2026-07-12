from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import JSONB_or_JSON, Base, TimestampMixin, UUIDPKMixin


class Workspace(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "workspaces"

    name: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)  # LocalizedString
    description: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    organization_id: Mapped[str | None] = mapped_column(String(36))
    badges: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    # LocalizedString ({"en": ..., "fr": ...}); JSON, not Text.
    readme: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    git_remote_config: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Fernet ciphertext of the git access token; never returned by the API.
    git_remote_secret: Mapped[str | None] = mapped_column(Text)
    origin: Mapped[str] = mapped_column(String(10), default="user", server_default="user")
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))

    members: Mapped[list["WorkspaceMember"]] = relationship(
        back_populates="workspace",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


from app.models.workspace_member import WorkspaceMember  # noqa: E402  (resolve forward ref)
