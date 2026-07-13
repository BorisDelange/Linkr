from sqlalchemy import String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class GitSyncState(Base):
    """The last remote commit an entity was known to be in sync with, per branch.

    This is the *anchor* the pull flow needs: with it we can tell "behind" (the
    remote moved past our anchor) from "diverged" (both sides moved) via
    merge-base, and later compute the 3-way object merge. Written on every push
    and on every resolved pull; adopted lazily on the first clean sync when
    missing (import / after-the-fact git-link — see git_service.sync_state).

    Keyed by (scope, entity_id, branch), shared across every versionable scope
    (projects, mapping-projects, sql-collections, etl-pipelines, data-catalogs,
    dq-rule-sets, schema-presets, user-plugins, workspaces) — same scopes as the
    repo-getters in git_service. Not a foreign key: the entity lives in another
    table and the row is always safe to drop (a missing anchor just re-adopts).
    """

    __tablename__ = "git_sync_state"
    __table_args__ = (
        UniqueConstraint("scope", "entity_id", "branch", name="uq_git_sync_state_key"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    scope: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[str] = mapped_column(String(64))
    branch: Mapped[str] = mapped_column(String(255))
    synced_oid: Mapped[str] = mapped_column(String(40))
    checked_at: Mapped[str] = mapped_column(String(40))
