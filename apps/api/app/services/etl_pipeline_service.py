from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.etl_pipeline import EtlFile, EtlPipeline, EtlRunHistory
from app.services import attachment_service, git_secret
from app.schemas.etl_pipeline import (
    EtlFileCreate,
    EtlFileUpdate,
    EtlPipelineCreate,
    EtlPipelineUpdate,
    EtlRunHistoryCreate,
    EtlRunHistoryUpdate,
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
    from app.services import git_service

    pipeline_id = pipeline.id
    await db.delete(pipeline)  # cascades to files via FK
    await db.commit()
    # The README attachments' owner is polymorphic (no FK), so clean them here.
    await attachment_service.delete_readme_for_owner(db, "etl-pipeline", pipeline_id)
    # Remove the on-disk versioning working tree so it doesn't linger as an orphan.
    git_service.remove_repo("etl-pipelines", pipeline_id)


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


# --- Run history -----------------------------------------------------------

# A pipeline keeps its recent runs, not all of them: a run is written on every
# progress tick, so an unbounded table would grow without ever being read past
# the first screen. Matches the cap the frontend store applies.
MAX_RUNS_PER_PIPELINE = 50


async def list_runs(db: AsyncSession, pipeline_id: str) -> list[EtlRunHistory]:
    result = await db.execute(
        select(EtlRunHistory)
        .where(EtlRunHistory.pipeline_id == pipeline_id)
        .order_by(EtlRunHistory.started_at.desc())
        .limit(MAX_RUNS_PER_PIPELINE)
    )
    return list(result.scalars().all())


async def get_run(db: AsyncSession, run_id: str) -> EtlRunHistory | None:
    return await db.get(EtlRunHistory, run_id)


async def create_run(
    db: AsyncSession, data: EtlRunHistoryCreate, user_id: int | None = None
) -> EtlRunHistory:
    payload = data.model_dump(exclude_none=True)
    # Idempotent: the client re-sends the same run id as the run progresses
    # (running → success), so this doubles as the upsert the store relies on.
    run = await db.get(EtlRunHistory, data.id)
    if run is None:
        run = EtlRunHistory()
        # Attributed once, at creation: later ticks must not reassign the run to
        # whoever happened to PUT it.
        run.created_by_id = user_id
    for key, value in payload.items():
        setattr(run, key, value)
    db.add(run)
    await db.commit()
    await db.refresh(run)
    await _prune_runs(db, data.pipeline_id)
    return run


async def update_run(
    db: AsyncSession, run: EtlRunHistory, data: EtlRunHistoryUpdate
) -> EtlRunHistory:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(run, key, value)
    await db.commit()
    await db.refresh(run)
    return run


async def delete_run(db: AsyncSession, run: EtlRunHistory) -> None:
    await db.delete(run)
    await db.commit()


async def delete_runs_for_pipeline(db: AsyncSession, pipeline_id: str) -> None:
    await db.execute(
        sa_delete(EtlRunHistory).where(EtlRunHistory.pipeline_id == pipeline_id)
    )
    await db.commit()


async def _prune_runs(db: AsyncSession, pipeline_id: str) -> None:
    """Drop the runs beyond the cap, oldest first."""
    result = await db.execute(
        select(EtlRunHistory.id)
        .where(EtlRunHistory.pipeline_id == pipeline_id)
        .order_by(EtlRunHistory.started_at.desc())
        .offset(MAX_RUNS_PER_PIPELINE)
    )
    stale = list(result.scalars().all())
    if not stale:
        return
    await db.execute(sa_delete(EtlRunHistory).where(EtlRunHistory.id.in_(stale)))
    await db.commit()
