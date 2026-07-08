from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.concept_set import ConceptSet
from app.schemas.concept_set import ConceptSetCreate, ConceptSetUpdate


async def list_all(db: AsyncSession) -> list[ConceptSet]:
    result = await db.execute(select(ConceptSet))
    return list(result.scalars().all())


async def list_for_workspace(db: AsyncSession, workspace_id: str) -> list[ConceptSet]:
    result = await db.execute(
        select(ConceptSet).where(ConceptSet.workspace_id == workspace_id)
    )
    return list(result.scalars().all())


async def get(db: AsyncSession, concept_set_id: str) -> ConceptSet | None:
    return await db.get(ConceptSet, concept_set_id)


async def create(db: AsyncSession, data: ConceptSetCreate) -> ConceptSet:
    concept_set = ConceptSet(**data.model_dump(exclude_none=True))
    db.add(concept_set)
    await db.commit()
    await db.refresh(concept_set)
    return concept_set


async def update(
    db: AsyncSession, concept_set: ConceptSet, data: ConceptSetUpdate
) -> ConceptSet:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(concept_set, key, value)
    await db.commit()
    await db.refresh(concept_set)
    return concept_set


async def delete(db: AsyncSession, concept_set: ConceptSet) -> None:
    await db.delete(concept_set)
    await db.commit()


async def delete_batch(db: AsyncSession, ids: list[str]) -> None:
    if not ids:
        return
    await db.execute(sa_delete(ConceptSet).where(ConceptSet.id.in_(ids)))
    await db.commit()
