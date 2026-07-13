from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.mapping_project import ConceptMapping, MappingProject, ServiceMapping
from app.models.user import User
from app.schemas.mapping_project import (
    ConceptMappingCreate,
    ConceptMappingUpdate,
    MappingProjectCreate,
    MappingProjectUpdate,
    ServiceMappingCreate,
    ServiceMappingUpdate,
)
from app.services import author_provenance, blob_store, git_secret


async def _sha_still_referenced(db: AsyncSession, sha: str) -> bool:
    """Whether any other mapping project still points at this content blob."""
    q = select(MappingProject.id).where(
        MappingProject.raw_file_sha == sha
    ).limit(1)
    return (await db.execute(q)).first() is not None


async def _forget_blob(db: AsyncSession, sha: str | None) -> None:
    """Delete an orphaned source-CSV blob once no row references it (the store is
    content-addressed + shared, so a reference check is required before removal)."""
    if sha and not await _sha_still_referenced(db, sha):
        await blob_store.delete(sha)


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


async def create(db: AsyncSession, data: MappingProjectCreate, owner: User) -> MappingProject:
    payload = data.model_dump(exclude_none=True)
    # A foreign instance's created_by_id is meaningless here — never persist it;
    # stamp_creator derives the right local id (ORCID/email match, or NULL).
    payload.pop("created_by_id", None)
    project = MappingProject()
    git_secret.apply_to_entity(project, payload)
    for key, value in payload.items():
        setattr(project, key, value)
    await author_provenance.stamp_creator(db, project, payload, owner)
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return project


async def update(
    db: AsyncSession, project: MappingProject, data: MappingProjectUpdate
) -> MappingProject:
    changes = data.model_dump(exclude_unset=True)
    git_secret.apply_to_entity(project, changes)
    old_sha = project.raw_file_sha
    for key, value in changes.items():
        setattr(project, key, value)
    await db.commit()
    await db.refresh(project)
    # A replaced source CSV leaves the previous blob orphaned — release it.
    if "raw_file_sha" in changes and old_sha and old_sha != project.raw_file_sha:
        await _forget_blob(db, old_sha)
    return project


async def delete(db: AsyncSession, project: MappingProject) -> None:
    sha = project.raw_file_sha
    await db.delete(project)  # cascades to concept_mappings via FK
    await db.commit()
    await _forget_blob(db, sha)


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
