from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.etl_pipeline import EtlFile, EtlPipeline
from app.services import git_secret
from app.schemas.etl_pipeline import (
    EtlFileCreate,
    EtlFileUpdate,
    EtlPipelineCreate,
    EtlPipelineUpdate,
)


# --- Pipelines -------------------------------------------------------------

async def list_all(db: AsyncSession) -> list[EtlPipeline]:
    result = await db.execute(select(EtlPipeline))
    return list(result.scalars().all())


async def list_for_workspace(db: AsyncSession, workspace_id: str) -> list[EtlPipeline]:
    result = await db.execute(
        select(EtlPipeline).where(EtlPipeline.workspace_id == workspace_id)
    )
    return list(result.scalars().all())


async def get(db: AsyncSession, pipeline_id: str) -> EtlPipeline | None:
    return await db.get(EtlPipeline, pipeline_id)


async def create(db: AsyncSession, data: EtlPipelineCreate) -> EtlPipeline:
    payload = data.model_dump(exclude_none=True)
    pipeline = EtlPipeline()
    git_secret.apply_to_entity(pipeline, payload)
    for key, value in payload.items():
        setattr(pipeline, key, value)
    db.add(pipeline)
    await db.commit()
    await db.refresh(pipeline)
    return pipeline


async def update(
    db: AsyncSession, pipeline: EtlPipeline, data: EtlPipelineUpdate
) -> EtlPipeline:
    changes = data.model_dump(exclude_unset=True)
    git_secret.apply_to_entity(pipeline, changes)
    for key, value in changes.items():
        setattr(pipeline, key, value)
    await db.commit()
    await db.refresh(pipeline)
    return pipeline


async def delete(db: AsyncSession, pipeline: EtlPipeline) -> None:
    await db.delete(pipeline)  # cascades to files via FK
    await db.commit()


# --- Files -----------------------------------------------------------------

async def list_files(db: AsyncSession, pipeline_id: str) -> list[EtlFile]:
    result = await db.execute(
        select(EtlFile).where(EtlFile.pipeline_id == pipeline_id)
    )
    return list(result.scalars().all())


async def get_file(db: AsyncSession, file_id: str) -> EtlFile | None:
    return await db.get(EtlFile, file_id)


async def create_file(db: AsyncSession, data: EtlFileCreate) -> EtlFile:
    node = EtlFile(**data.model_dump(exclude_none=True))
    db.add(node)
    await db.commit()
    await db.refresh(node)
    return node


async def update_file(
    db: AsyncSession, node: EtlFile, data: EtlFileUpdate
) -> EtlFile:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(node, key, value)
    await db.commit()
    await db.refresh(node)
    return node


async def delete_file(db: AsyncSession, node: EtlFile) -> None:
    await db.delete(node)
    await db.commit()


async def delete_files_for_pipeline(db: AsyncSession, pipeline_id: str) -> None:
    await db.execute(
        sa_delete(EtlFile).where(EtlFile.pipeline_id == pipeline_id)
    )
    await db.commit()
