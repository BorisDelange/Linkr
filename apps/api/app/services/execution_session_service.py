from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.execution_session import ExecutionSession
from app.schemas.execution_session import ExecutionSessionCreate


async def list_for_user(
    db: AsyncSession, project_uid: str, user_id: int
) -> list[ExecutionSession]:
    result = await db.execute(
        select(ExecutionSession)
        .where(ExecutionSession.project_uid == project_uid)
        .where(ExecutionSession.user_id == user_id)
        .order_by(ExecutionSession.created_at)
    )
    return list(result.scalars().all())


async def get(db: AsyncSession, session_id: str) -> ExecutionSession | None:
    return await db.get(ExecutionSession, session_id)


async def create(
    db: AsyncSession, data: ExecutionSessionCreate, user_id: int
) -> ExecutionSession:
    session = ExecutionSession(
        id=data.id,
        project_uid=data.project_uid,
        user_id=user_id,
        name=data.name,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return session


async def delete(db: AsyncSession, session: ExecutionSession) -> None:
    await db.delete(session)
    await db.commit()
