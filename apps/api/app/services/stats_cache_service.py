from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.stats_cache import StatsCache


async def get(db: AsyncSession, scope: str, cache_key: str) -> StatsCache | None:
    result = await db.execute(
        select(StatsCache).where(
            StatsCache.scope == scope, StatsCache.cache_key == cache_key
        )
    )
    return result.scalar_one_or_none()


async def save(
    db: AsyncSession, scope: str, cache_key: str, computed_at: str, payload: dict
) -> StatsCache:
    row = await get(db, scope, cache_key)
    if row is None:
        row = StatsCache(
            scope=scope, cache_key=cache_key, computed_at=computed_at, payload=payload
        )
        db.add(row)
    else:
        row.computed_at = computed_at
        row.payload = payload
    await db.commit()
    await db.refresh(row)
    return row


async def delete(db: AsyncSession, scope: str, cache_key: str) -> None:
    await db.execute(
        sa_delete(StatsCache).where(
            StatsCache.scope == scope, StatsCache.cache_key == cache_key
        )
    )
    await db.commit()
