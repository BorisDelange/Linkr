from sqlalchemy import String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin, UUIDPKMixin


class StatsCache(Base, UUIDPKMixin, TimestampMixin):
    """Shared, recomputable cache of expensive read-only results (database stats,
    catalog results). Keyed by (scope, cache_key) so all users of a project/
    workspace reuse one computed payload instead of each recomputing into their
    own browser IndexedDB. Purged/overwritten on explicit refresh.

    scope: 'database' (cache_key = data_source_id) | 'catalog' (cache_key = catalog_id).
    Not a foreign key — the entity may live in a different store and the cache is
    always safe to drop; orphans are pruned when the owning entity is deleted.
    """

    __tablename__ = "stats_cache"
    __table_args__ = (UniqueConstraint("scope", "cache_key", name="uq_stats_cache_scope_key"),)

    scope: Mapped[str] = mapped_column(String(30))
    cache_key: Mapped[str] = mapped_column(String(64))
    computed_at: Mapped[str] = mapped_column(String(40))
    payload: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
