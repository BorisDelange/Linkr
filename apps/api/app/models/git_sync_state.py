from sqlalchemy import String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class GitSyncState(Base):
    """Where an entity stands against a remote branch: two distinct commits.

    `synced_oid` — **content anchor**: "we hold this commit's content". It is the
    BASE of the 3-way merge, so it may only advance when a pull took *everything*
    on offer. Moving it on a partial pull would clear the banner and bury the
    un-taken items for good: every later plan is rebuilt against the new base, so
    what was skipped is never offered again.

    `reviewed_oid` — **decision cursor**: "every item this commit brought got an
    explicit decision (taken, or deliberately declined)". This is what gates the
    push. Splitting it from the anchor is what makes a *partial* pull expressible:
    take three mappings, keep yours on two, and you are done deliberating — the
    two you kept simply reappear as local changes to push, which is the truth.
    Without the split, `synced_oid` had to mean both things at once, so a partial
    pull either buried the remainder or blocked the push forever.

    `behind` is computed against `reviewed_oid` when set, else `synced_oid` (rows
    predating the split keep their previous behaviour).

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
    # Nullable: rows written before the split have no decision cursor, and
    # `behind` falls back to synced_oid for them.
    reviewed_oid: Mapped[str | None] = mapped_column(String(40), nullable=True)
    checked_at: Mapped[str] = mapped_column(String(40))
