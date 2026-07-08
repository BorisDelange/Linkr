from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user_plugin import UserPlugin
from app.schemas.user_plugin import UserPluginCreate, UserPluginUpdate


async def list_all(db: AsyncSession) -> list[UserPlugin]:
    result = await db.execute(select(UserPlugin))
    return list(result.scalars().all())


async def list_for_workspace(db: AsyncSession, workspace_id: str) -> list[UserPlugin]:
    result = await db.execute(
        select(UserPlugin).where(UserPlugin.workspace_id == workspace_id)
    )
    return list(result.scalars().all())


async def get(db: AsyncSession, plugin_id: str) -> UserPlugin | None:
    return await db.get(UserPlugin, plugin_id)


async def create(db: AsyncSession, data: UserPluginCreate) -> UserPlugin:
    plugin = UserPlugin(**data.model_dump(exclude_none=True))
    db.add(plugin)
    await db.commit()
    await db.refresh(plugin)
    return plugin


async def update(db: AsyncSession, plugin: UserPlugin, data: UserPluginUpdate) -> UserPlugin:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(plugin, key, value)
    await db.commit()
    await db.refresh(plugin)
    return plugin


async def delete(db: AsyncSession, plugin: UserPlugin) -> None:
    await db.delete(plugin)
    await db.commit()
