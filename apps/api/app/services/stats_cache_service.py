from sqlalchemy import Text, cast, select, update
from sqlalchemy import delete as sa_delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.stats_cache import StatsCache


async def get(db: AsyncSession, scope: str, cache_key: str) -> StatsCache | None:
    result = await db.execute(
        select(StatsCache).where(
            StatsCache.scope == scope, StatsCache.cache_key == cache_key
        )
    )
    return result.scalar_one_or_none()


async def get_raw(db: AsyncSession, scope: str, cache_key: str) -> tuple[str, str] | None:
    """(computed_at, payload as JSON text), for a payload served as is.

    A catalog's results run to tens of megabytes: parsing them into Python
    objects only to validate and encode them back took seconds per read.
    """
    result = await db.execute(
        select(StatsCache.computed_at, cast(StatsCache.payload, Text)).where(
            StatsCache.scope == scope, StatsCache.cache_key == cache_key
        )
    )
    row = result.first()
    return (row[0], row[1]) if row else None


async def save(
    db: AsyncSession, scope: str, cache_key: str, computed_at: str, payload: dict
) -> None:
    """Store `payload` under (scope, cache_key), replacing what was there.

    Neither the previous payload nor the one just written is read back: a
    catalog's results run to tens of megabytes.
    """
    updated = await db.execute(
        update(StatsCache)
        .where(StatsCache.scope == scope, StatsCache.cache_key == cache_key)
        .values(computed_at=computed_at, payload=payload)
        .execution_options(synchronize_session=False)
    )
    if updated.rowcount == 0:
        db.add(StatsCache(scope=scope, cache_key=cache_key, computed_at=computed_at, payload=payload))
    await db.commit()


async def delete(db: AsyncSession, scope: str, cache_key: str) -> None:
    await db.execute(
        sa_delete(StatsCache).where(
            StatsCache.scope == scope, StatsCache.cache_key == cache_key
        )
    )
    await db.commit()


async def delete_with_prefix(db: AsyncSession, scope: str, key_prefix: str) -> None:
    """Drop `key_prefix` and every `key_prefix:<principal>` entry of `scope`."""
    await db.execute(
        sa_delete(StatsCache).where(
            StatsCache.scope == scope,
            (StatsCache.cache_key == key_prefix) | StatsCache.cache_key.startswith(f"{key_prefix}:"),
        )
    )
    await db.commit()
