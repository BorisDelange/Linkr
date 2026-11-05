from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.permissions import has_project_permission
from app.models.concept_list import ConceptList
from app.models.user import User
from app.schemas.concept_list import ConceptListCreate, ConceptListUpdate
from app.services import project_service


async def list_for_project(db: AsyncSession, project_uid: str) -> list[ConceptList]:
    result = await db.execute(
        select(ConceptList).where(ConceptList.project_uid == project_uid)
    )
    return list(result.scalars().all())


async def list_for_user(db: AsyncSession, user: User) -> list[ConceptList]:
    """Concept lists of the projects the user sees (project_service's
    visibility, "none" overrides included) where they hold `concepts:read` —
    admins see all. The store loads everything then filters by project
    client-side."""
    if user.role == "admin":
        result = await db.execute(select(ConceptList))
        return list(result.scalars().all())

    readable = [
        p.uid for p in await project_service.list_for_user(db, user)
        if await has_project_permission(db, p, user, "concepts:read")
    ]
    if not readable:
        return []
    result = await db.execute(select(ConceptList).where(ConceptList.project_uid.in_(readable)))
    return list(result.scalars().all())


async def get(db: AsyncSession, concept_list_id: str) -> ConceptList | None:
    return await db.get(ConceptList, concept_list_id)


async def create(db: AsyncSession, data: ConceptListCreate) -> ConceptList:
    concept_list = ConceptList(**data.model_dump(exclude_none=True))
    db.add(concept_list)
    await db.commit()
    await db.refresh(concept_list)
    return concept_list


async def update(
    db: AsyncSession, concept_list: ConceptList, data: ConceptListUpdate
) -> ConceptList:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(concept_list, key, value)
    await db.commit()
    await db.refresh(concept_list)
    return concept_list


async def delete(db: AsyncSession, concept_list: ConceptList) -> None:
    await db.delete(concept_list)
    await db.commit()


async def delete_for_project(db: AsyncSession, project_uid: str) -> None:
    await db.execute(
        sa_delete(ConceptList).where(ConceptList.project_uid == project_uid)
    )
    await db.commit()
