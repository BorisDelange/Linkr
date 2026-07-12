from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.entity_visit import EntityVisit
from app.schemas.entity_visit import EntityVisitRecord


async def list_for_user(db: AsyncSession, user_id: int) -> list[EntityVisit]:
    result = await db.execute(
        select(EntityVisit).where(EntityVisit.user_id == user_id)
    )
    return list(result.scalars().all())


async def _get(db: AsyncSession, user_id: int, data: EntityVisitRecord) -> EntityVisit | None:
    result = await db.execute(
        select(EntityVisit).where(
            EntityVisit.user_id == user_id,
            EntityVisit.entity_type == data.entity_type,
            EntityVisit.entity_id == data.entity_id,
        )
    )
    return result.scalar_one_or_none()


async def record(
    db: AsyncSession, user_id: int, data: EntityVisitRecord
) -> EntityVisit:
    """Upsert the (user, entity) visit: bump `visited_at` if it exists, else insert.

    Two concurrent first-visits both see "absent" and both insert; the loser hits
    the uq_entity_visits_user_entity constraint. Catch that, roll back, and fall
    through to the update path so a racing double-visit never 500s."""
    visit = await _get(db, user_id, data)
    if visit is None:
        visit = EntityVisit(
            user_id=user_id,
            entity_type=data.entity_type,
            entity_id=data.entity_id,
            visited_at=data.visited_at,
        )
        db.add(visit)
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            visit = await _get(db, user_id, data)  # the other insert won → update it
            if visit is None:
                raise
            visit.visited_at = data.visited_at
            await db.commit()
    else:
        visit.visited_at = data.visited_at
        await db.commit()
    await db.refresh(visit)
    return visit
