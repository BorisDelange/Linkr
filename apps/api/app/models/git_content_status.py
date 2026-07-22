from sqlalchemy import String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class GitContentStatus(Base):
    """Per-instance reconstitution status of a git-linked entity's CONTENT.

    A git-linked child imports as a minimal pointer first, then its content is
    cloned from the linked repo. This row records whether that clone is still
    ``pending`` (pointer imported, clone not yet done — e.g. ZIP import, or
    client-only) or ``failed`` (clone attempted and errored). A successful clone
    clears the row (absence == reconstituted / normal). The UI reads it to show a
    "content not imported" badge + a retry button on the entity card.

    Keyed by (scope, entity_id) across every versionable scope, like
    git_sync_state. Purely instance state: never exported, safe to drop.
    """

    __tablename__ = "git_content_status"
    __table_args__ = (
        UniqueConstraint("scope", "entity_id", name="uq_git_content_status_key"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    scope: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[str] = mapped_column(String(64))
    workspace_id: Mapped[str] = mapped_column(String(36), index=True)
    status: Mapped[str] = mapped_column(String(20))  # 'pending' | 'failed'
