from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pipeline import Pipeline
from app.models.project import Project
from app.models.user import User
from app.models.workspace_member import WorkspaceMember
from app.schemas.pipeline import PipelineCreate, PipelineUpdate


async def list_for_project(db: AsyncSession, project_uid: str) -> list[Pipeline]:
    result = await db.execute(
        select(Pipeline).where(Pipeline.project_uid == project_uid)
    )
    return list(result.scalars().all())


async def list_for_user(db: AsyncSession, user: User) -> list[Pipeline]:
    """Pipelines in projects the user can reach (admins see all).

    The pipeline store loads everything then filters by project client-side; in
    server mode we scope to the user's accessible workspaces instead of exposing
    every project's pipelines.
    """
    if user.role == "admin":
        result = await db.execute(select(Pipeline))
        return list(result.scalars().all())

    result = await db.execute(
        select(Pipeline)
        .join(Project, Project.uid == Pipeline.project_uid)
        .join(
            WorkspaceMember,
            WorkspaceMember.workspace_id == Project.workspace_id,
        )
        .where(WorkspaceMember.user_id == user.id)
    )
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
