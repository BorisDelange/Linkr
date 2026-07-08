from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import crypto
from app.models.ide_connection import IdeConnection
from app.schemas.ide_connection import IdeConnectionCreate, IdeConnectionUpdate
from app.services.data_source_service import _extract_secret, strip_secrets


async def list_for_project(db: AsyncSession, project_uid: str) -> list[IdeConnection]:
    result = await db.execute(
        select(IdeConnection).where(IdeConnection.project_uid == project_uid)
    )
    return list(result.scalars().all())


async def get(db: AsyncSession, connection_id: str) -> IdeConnection | None:
    return await db.get(IdeConnection, connection_id)


async def create(db: AsyncSession, data: IdeConnectionCreate) -> IdeConnection:
    payload = data.model_dump(exclude_none=True)
    config = payload.get("connection_config")
    secret = _extract_secret(config)
    payload["connection_config"] = strip_secrets(config)
    connection = IdeConnection(
        **payload,
        connection_secret=crypto.encrypt(secret) if secret else None,
    )
    db.add(connection)
    await db.commit()
    await db.refresh(connection)
    return connection


async def update(
    db: AsyncSession, connection: IdeConnection, data: IdeConnectionUpdate
) -> IdeConnection:
    changes = data.model_dump(exclude_unset=True)
    if "connection_config" in changes:
        # A password/token present in the update re-encrypts; its absence leaves
        # the stored secret untouched (editing other fields keeps credentials).
        secret = _extract_secret(changes["connection_config"])
        if secret is not None:
            connection.connection_secret = crypto.encrypt(secret)
        changes["connection_config"] = strip_secrets(changes["connection_config"])
    for key, value in changes.items():
        setattr(connection, key, value)
    await db.commit()
    await db.refresh(connection)
    return connection


async def delete(db: AsyncSession, connection: IdeConnection) -> None:
    await db.delete(connection)
    await db.commit()


async def delete_for_project(db: AsyncSession, project_uid: str) -> None:
    await db.execute(
        sa_delete(IdeConnection).where(IdeConnection.project_uid == project_uid)
    )
    await db.commit()
