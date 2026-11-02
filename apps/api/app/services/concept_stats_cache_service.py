from sqlalchemy import delete as sa_delete
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.concept_stats_cache import ConceptStatsCache

# The table's `principal` key column held a user for an external database; the
# cache is now one per source, under "". TODO(concept-profiles): drop the table
# once the concept panel reads the profile store (plan step 4).
_SHARED = ""


async def get(db: AsyncSession, data_source_id: str, concept_id: int) -> ConceptStatsCache | None:
    return await db.get(ConceptStatsCache, (data_source_id, concept_id, _SHARED))


async def save(db: AsyncSession, data_source_id: str, concept_id: int, stats: dict) -> ConceptStatsCache:
    row = await get(db, data_source_id, concept_id)
    if row is None:
        row = ConceptStatsCache(
            data_source_id=data_source_id, concept_id=concept_id, principal=_SHARED, stats=stats
        )
        db.add(row)
        try:
            await db.commit()
        except IntegrityError:
            # Another first save of this key committed between our get and this
            # insert: the row exists now, so overwrite it (same shape as
            # stats_cache_service.save).
            await db.rollback()
            row = await get(db, data_source_id, concept_id)
            if row is None:
                row = ConceptStatsCache(
                    data_source_id=data_source_id,
                    concept_id=concept_id,
                    principal=_SHARED,
                    stats=stats,
                )
                db.add(row)
            else:
                row.stats = stats
            await db.commit()
    else:
        row.stats = stats
        await db.commit()
    await db.refresh(row)
    return row


async def delete_for_source(db: AsyncSession, data_source_id: str) -> None:
    """Drop the cached stats of a source (when it changes)."""
    await db.execute(sa_delete(ConceptStatsCache).where(ConceptStatsCache.data_source_id == data_source_id))
    await db.commit()
