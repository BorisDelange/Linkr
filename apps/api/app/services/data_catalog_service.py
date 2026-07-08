from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.data_catalog import DataCatalog
from app.schemas.data_catalog import DataCatalogCreate, DataCatalogUpdate


async def list_all(db: AsyncSession) -> list[DataCatalog]:
    result = await db.execute(select(DataCatalog))
    return list(result.scalars().all())


async def list_for_workspace(db: AsyncSession, workspace_id: str) -> list[DataCatalog]:
    result = await db.execute(
        select(DataCatalog).where(DataCatalog.workspace_id == workspace_id)
    )
    return list(result.scalars().all())


async def get(db: AsyncSession, catalog_id: str) -> DataCatalog | None:
    return await db.get(DataCatalog, catalog_id)


async def create(db: AsyncSession, data: DataCatalogCreate) -> DataCatalog:
    catalog = DataCatalog(**data.model_dump(exclude_none=True))
    db.add(catalog)
    await db.commit()
    await db.refresh(catalog)
    return catalog


async def update(
    db: AsyncSession, catalog: DataCatalog, data: DataCatalogUpdate
) -> DataCatalog:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(catalog, key, value)
    await db.commit()
    await db.refresh(catalog)
    return catalog


async def delete(db: AsyncSession, catalog: DataCatalog) -> None:
    await db.delete(catalog)
    await db.commit()
