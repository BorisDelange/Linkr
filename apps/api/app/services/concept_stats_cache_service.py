from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.concept_stats_cache import ConceptStatsCache


async def get(
    db: AsyncSession, data_source_id: str, concept_id: int
) -> ConceptStatsCache | None:
    return await db.get(ConceptStatsCache, (data_source_id, concept_id))


async def save(
    db: AsyncSession, data_source_id: str, concept_id: int, stats: dict
) -> ConceptStatsCache:
    row = await db.get(ConceptStatsCache, (data_source_id, concept_id))
    if row is None:
        row = ConceptStatsCache(
            data_source_id=data_source_id, concept_id=concept_id, stats=stats
        )
        db.add(row)
    else:
        row.stats = stats
    await db.commit()
    await db.refresh(row)
    return row


async def delete_for_source(db: AsyncSession, data_source_id: str) -> None:
    """Drop every cached stat for a source (called when the source changes)."""
    await db.execute(
        sa_delete(ConceptStatsCache).where(
            ConceptStatsCache.data_source_id == data_source_id
        )
    )
    await db.commit()


async def list_for_source(
    db: AsyncSession, data_source_id: str
) -> list[ConceptStatsCache]:
    result = await db.execute(
        select(ConceptStatsCache).where(
            ConceptStatsCache.data_source_id == data_source_id
        )
    )
    return list(result.scalars().all())
