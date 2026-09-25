from sqlalchemy import delete as sa_delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.concept_stats_cache import ConceptStatsCache


async def get(
    db: AsyncSession, data_source_id: str, concept_id: int, principal: str
) -> ConceptStatsCache | None:
    return await db.get(ConceptStatsCache, (data_source_id, concept_id, principal))


async def save(
    db: AsyncSession, data_source_id: str, concept_id: int, principal: str, stats: dict
) -> ConceptStatsCache:
    row = await get(db, data_source_id, concept_id, principal)
    if row is None:
        row = ConceptStatsCache(
            data_source_id=data_source_id, concept_id=concept_id, principal=principal, stats=stats
        )
        db.add(row)
    else:
        row.stats = stats
    await db.commit()
    await db.refresh(row)
    return row


async def delete_for_source(
    db: AsyncSession, data_source_id: str, principal: str | None = None
) -> None:
    """Drop the cached stats of a source (when it changes) — every principal's,
    or only `principal`'s (when that user's login changes)."""
    stmt = sa_delete(ConceptStatsCache).where(ConceptStatsCache.data_source_id == data_source_id)
    if principal is not None:
        stmt = stmt.where(ConceptStatsCache.principal == principal)
    await db.execute(stmt)
    await db.commit()
