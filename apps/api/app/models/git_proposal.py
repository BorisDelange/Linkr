from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class GitProposal(Base, TimestampMixin):
    """A merge request (GitLab) or pull request (GitHub) opened from Linkr for one
    versioned entity: its changes pushed on `branch`, proposed into `target_branch`.

    `state` mirrors the forge's (open / merged / closed) as last read; the forge is
    the truth, Linkr only refreshes it. Keyed like git_sync_state by (scope,
    entity_id) and not a foreign key to the entity, for the same reason.
    """

    __tablename__ = "git_proposals"

    id: Mapped[int] = mapped_column(primary_key=True)
    scope: Mapped[str] = mapped_column(String(40), index=True)
    entity_id: Mapped[str] = mapped_column(String(64), index=True)
    branch: Mapped[str] = mapped_column(String(255))
    target_branch: Mapped[str] = mapped_column(String(255))
    forge: Mapped[str] = mapped_column(String(20))
    number: Mapped[int] = mapped_column(Integer)
    url: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    state: Mapped[str] = mapped_column(String(20), default="open")
    author_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
