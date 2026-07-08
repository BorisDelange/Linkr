from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.mapping_project import ConceptMapping, MappingProject, ServiceMapping
from app.schemas.mapping_project import (
    ConceptMappingCreate,
    ConceptMappingUpdate,
    MappingProjectCreate,
    MappingProjectUpdate,
    ServiceMappingCreate,
    ServiceMappingUpdate,
)


# --- Mapping projects ------------------------------------------------------

async def list_all(db: AsyncSession) -> list[MappingProject]:
    result = await db.execute(select(MappingProject))
    return list(result.scalars().all())


async def list_for_workspace(db: AsyncSession, workspace_id: str) -> list[MappingProject]:
    result = await db.execute(
        select(MappingProject).where(MappingProject.workspace_id == workspace_id)
    )
    return list(result.scalars().all())


async def get(db: AsyncSession, project_id: str) -> MappingProject | None:
    return await db.get(MappingProject, project_id)


async def create(db: AsyncSession, data: MappingProjectCreate) -> MappingProject:
    project = MappingProject(**data.model_dump(exclude_none=True))
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return project


async def update(
    db: AsyncSession, project: MappingProject, data: MappingProjectUpdate
) -> MappingProject:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(project, key, value)
    await db.commit()
    await db.refresh(project)
    return project


async def delete(db: AsyncSession, project: MappingProject) -> None:
    await db.delete(project)  # cascades to concept_mappings via FK
    await db.commit()


# --- Concept mappings (per-project) ----------------------------------------

async def list_mappings(db: AsyncSession, project_id: str) -> list[ConceptMapping]:
    result = await db.execute(
        select(ConceptMapping).where(ConceptMapping.project_id == project_id)
    )
    return list(result.scalars().all())


async def get_mapping(db: AsyncSession, mapping_id: str) -> ConceptMapping | None:
    return await db.get(ConceptMapping, mapping_id)


async def create_mapping(db: AsyncSession, data: ConceptMappingCreate) -> ConceptMapping:
    mapping = ConceptMapping(**data.model_dump(exclude_none=True))
    db.add(mapping)
    await db.commit()
    await db.refresh(mapping)
    return mapping


async def create_mappings_batch(
    db: AsyncSession, items: list[ConceptMappingCreate]
) -> None:
    for data in items:
        db.add(ConceptMapping(**data.model_dump(exclude_none=True)))
    await db.commit()


async def update_mapping(
    db: AsyncSession, mapping: ConceptMapping, data: ConceptMappingUpdate
) -> ConceptMapping:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(mapping, key, value)
    await db.commit()
    await db.refresh(mapping)
    return mapping


async def delete_mapping(db: AsyncSession, mapping: ConceptMapping) -> None:
    await db.delete(mapping)
    await db.commit()


async def delete_mappings_for_project(db: AsyncSession, project_id: str) -> None:
    await db.execute(
        sa_delete(ConceptMapping).where(ConceptMapping.project_id == project_id)
    )
    await db.commit()


async def delete_mappings_for_projects(
    db: AsyncSession, project_ids: list[str]
) -> int:
    if not project_ids:
        return 0
    result = await db.execute(
        sa_delete(ConceptMapping).where(ConceptMapping.project_id.in_(project_ids))
    )
    await db.commit()
    return result.rowcount or 0


async def delete_orphan_mappings(
    db: AsyncSession, valid_project_ids: list[str]
) -> int:
    """Delete mappings whose project no longer exists in the given valid set."""
    stmt = sa_delete(ConceptMapping)
    if valid_project_ids:
        stmt = stmt.where(ConceptMapping.project_id.notin_(valid_project_ids))
    result = await db.execute(stmt)
    await db.commit()
    return result.rowcount or 0


# --- Service mappings ------------------------------------------------------

async def list_service_mappings_all(db: AsyncSession) -> list[ServiceMapping]:
    result = await db.execute(select(ServiceMapping))
    return list(result.scalars().all())


async def list_service_mappings_for_workspace(
    db: AsyncSession, workspace_id: str
) -> list[ServiceMapping]:
    result = await db.execute(
        select(ServiceMapping).where(ServiceMapping.workspace_id == workspace_id)
    )
    return list(result.scalars().all())


async def get_service_mapping(db: AsyncSession, mapping_id: str) -> ServiceMapping | None:
    return await db.get(ServiceMapping, mapping_id)


async def create_service_mapping(
    db: AsyncSession, data: ServiceMappingCreate
) -> ServiceMapping:
    mapping = ServiceMapping(**data.model_dump(exclude_none=True))
    db.add(mapping)
    await db.commit()
    await db.refresh(mapping)
    return mapping


async def update_service_mapping(
    db: AsyncSession, mapping: ServiceMapping, data: ServiceMappingUpdate
) -> ServiceMapping:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(mapping, key, value)
    await db.commit()
    await db.refresh(mapping)
    return mapping


async def delete_service_mapping(db: AsyncSession, mapping: ServiceMapping) -> None:
    await db.delete(mapping)
    await db.commit()
