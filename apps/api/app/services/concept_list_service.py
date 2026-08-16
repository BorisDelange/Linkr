from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.concept_list import ConceptList
from app.models.project import Project
from app.models.user import User
from app.models.workspace_member import WorkspaceMember
from app.schemas.concept_list import ConceptListCreate, ConceptListUpdate


async def list_for_project(db: AsyncSession, project_uid: str) -> list[ConceptList]:
    result = await db.execute(
        select(ConceptList).where(ConceptList.project_uid == project_uid)
    )
    return list(result.scalars().all())


async def list_for_user(db: AsyncSession, user: User) -> list[ConceptList]:
    """Concept lists in projects the user can reach (admins see all). The store
    loads everything then filters by project client-side; scope to accessible
    workspaces in server mode."""
    if user.role == "admin":
        result = await db.execute(select(ConceptList))
        return list(result.scalars().all())

    result = await db.execute(
        select(ConceptList)
        .join(Project, Project.uid == ConceptList.project_uid)
        .join(
            WorkspaceMember,
            WorkspaceMember.workspace_id == Project.workspace_id,
        )
        .where(WorkspaceMember.user_id == user.id)
    )
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
