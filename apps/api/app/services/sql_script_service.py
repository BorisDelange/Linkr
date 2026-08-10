from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.sql_script import SqlScriptCollection, SqlScriptFile
from app.schemas.sql_script import (
    SqlScriptCollectionCreate,
    SqlScriptCollectionUpdate,
    SqlScriptFileCreate,
    SqlScriptFileUpdate,
)
from app.services import attachment_service, git_secret


# --- Collections -----------------------------------------------------------

async def list_all(db: AsyncSession) -> list[SqlScriptCollection]:
    result = await db.execute(select(SqlScriptCollection))
    return list(result.scalars().all())


async def list_for_workspace(
    db: AsyncSession, workspace_id: str
) -> list[SqlScriptCollection]:
    result = await db.execute(
        select(SqlScriptCollection).where(
            SqlScriptCollection.workspace_id == workspace_id
        )
    )
    return list(result.scalars().all())


async def get(db: AsyncSession, collection_id: str) -> SqlScriptCollection | None:
    return await db.get(SqlScriptCollection, collection_id)


async def create(
    db: AsyncSession, data: SqlScriptCollectionCreate
) -> SqlScriptCollection:
    payload = data.model_dump(exclude_none=True)
    collection = SqlScriptCollection()
    git_secret.apply_to_entity(collection, payload)
    for key, value in payload.items():
        setattr(collection, key, value)
    db.add(collection)
    await db.commit()
    await db.refresh(collection)
    return collection


async def update(
    db: AsyncSession, collection: SqlScriptCollection, data: SqlScriptCollectionUpdate
) -> SqlScriptCollection:
    changes = data.model_dump(exclude_unset=True)
    git_secret.apply_to_entity(collection, changes)
    for key, value in changes.items():
        setattr(collection, key, value)
    await db.commit()
    await db.refresh(collection)
    return collection


async def delete(db: AsyncSession, collection: SqlScriptCollection) -> None:
    collection_id = collection.id
    await db.delete(collection)  # cascades to files via FK
    await db.commit()
    # The README attachments' owner is polymorphic (no FK), so clean them here.
    await attachment_service.delete_readme_for_owner(db, "sql-collection", collection_id)


# --- Files -----------------------------------------------------------------

async def list_files(db: AsyncSession, collection_id: str) -> list[SqlScriptFile]:
    result = await db.execute(
        select(SqlScriptFile).where(SqlScriptFile.collection_id == collection_id)
    )
    return list(result.scalars().all())


async def get_file(db: AsyncSession, file_id: str) -> SqlScriptFile | None:
    return await db.get(SqlScriptFile, file_id)


async def create_file(db: AsyncSession, data: SqlScriptFileCreate) -> SqlScriptFile:
    node = SqlScriptFile(**data.model_dump(exclude_none=True))
    db.add(node)
    await db.commit()
    await db.refresh(node)
    return node


async def update_file(
    db: AsyncSession, node: SqlScriptFile, data: SqlScriptFileUpdate
) -> SqlScriptFile:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(node, key, value)
    await db.commit()
    await db.refresh(node)
    return node


async def delete_file(db: AsyncSession, node: SqlScriptFile) -> None:
    await db.delete(node)
    await db.commit()


async def delete_files_for_collection(db: AsyncSession, collection_id: str) -> None:
    await db.execute(
        sa_delete(SqlScriptFile).where(SqlScriptFile.collection_id == collection_id)
    )
    await db.commit()
