from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.entity_visit import EntityVisit
from app.schemas.entity_visit import EntityVisitRecord


async def list_for_user(db: AsyncSession, user_id: int) -> list[EntityVisit]:
    result = await db.execute(
        select(EntityVisit).where(EntityVisit.user_id == user_id)
    )
    return list(result.scalars().all())


async def record(
    db: AsyncSession, user_id: int, data: EntityVisitRecord
) -> EntityVisit:
    """Upsert the (user, entity) visit: bump `visited_at` if it exists, else insert."""
    result = await db.execute(
        select(EntityVisit).where(
            EntityVisit.user_id == user_id,
            EntityVisit.entity_type == data.entity_type,
            EntityVisit.entity_id == data.entity_id,
        )
    )
    visit = result.scalar_one_or_none()
    if visit is None:
        visit = EntityVisit(
            user_id=user_id,
            entity_type=data.entity_type,
            entity_id=data.entity_id,
            visited_at=data.visited_at,
        )
        db.add(visit)
    else:
        visit.visited_at = data.visited_at
    await db.commit()
    await db.refresh(visit)
    return visit
