from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.organization import Organization
from app.schemas.organization import OrganizationCreate, OrganizationUpdate


async def list_all(db: AsyncSession) -> list[Organization]:
    result = await db.execute(select(Organization))
    return list(result.scalars().all())


async def get(db: AsyncSession, org_id: str) -> Organization | None:
    return await db.get(Organization, org_id)


async def create(db: AsyncSession, data: OrganizationCreate) -> Organization:
    org = Organization(**data.model_dump(exclude_none=True))
    db.add(org)
    await db.commit()
    await db.refresh(org)
    return org


async def update(
    db: AsyncSession, org: Organization, data: OrganizationUpdate
) -> Organization:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(org, key, value)
    await db.commit()
    await db.refresh(org)
    return org


async def delete(db: AsyncSession, org: Organization) -> None:
    await db.delete(org)
    await db.commit()
