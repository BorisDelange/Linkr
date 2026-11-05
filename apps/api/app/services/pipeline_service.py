from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.permissions import has_project_permission
from app.models.pipeline import Pipeline
from app.models.user import User
from app.schemas.pipeline import PipelineCreate, PipelineUpdate
from app.services import project_service


async def list_for_project(db: AsyncSession, project_uid: str) -> list[Pipeline]:
    result = await db.execute(
        select(Pipeline).where(Pipeline.project_uid == project_uid)
    )
    return list(result.scalars().all())


async def list_for_user(db: AsyncSession, user: User) -> list[Pipeline]:
    """Pipelines of the projects the user sees (project_service's visibility,
    "none" overrides included) where they hold `pipeline:read` — admins see all.

    The pipeline store loads everything then filters by project client-side.
    """
    if user.role == "admin":
        result = await db.execute(select(Pipeline))
        return list(result.scalars().all())

    readable = [
        p.uid for p in await project_service.list_for_user(db, user)
        if await has_project_permission(db, p, user, "pipeline:read")
    ]
    if not readable:
        return []
    result = await db.execute(select(Pipeline).where(Pipeline.project_uid.in_(readable)))
    return list(result.scalars().all())


async def get(db: AsyncSession, pipeline_id: str) -> Pipeline | None:
    return await db.get(Pipeline, pipeline_id)


async def create(db: AsyncSession, data: PipelineCreate) -> Pipeline:
    pipeline = Pipeline(**data.model_dump())
    db.add(pipeline)
    await db.commit()
    await db.refresh(pipeline)
    return pipeline


async def update(
    db: AsyncSession, pipeline: Pipeline, data: PipelineUpdate
) -> Pipeline:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(pipeline, key, value)
    await db.commit()
    await db.refresh(pipeline)
    return pipeline


async def delete(db: AsyncSession, pipeline: Pipeline) -> None:
    await db.delete(pipeline)
    await db.commit()


async def delete_for_project(db: AsyncSession, project_uid: str) -> None:
    await db.execute(
        sa_delete(Pipeline).where(Pipeline.project_uid == project_uid)
    )
    await db.commit()
