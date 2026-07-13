from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user_plugin import UserPlugin
from app.schemas.user_plugin import UserPluginCreate, UserPluginUpdate
from app.services import git_secret


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
    payload = data.model_dump(exclude_none=True)
    plugin = UserPlugin()
    git_secret.apply_to_entity(plugin, payload)
    for key, value in payload.items():
        setattr(plugin, key, value)
    db.add(plugin)
    await db.commit()
    await db.refresh(plugin)
    return plugin


async def update(db: AsyncSession, plugin: UserPlugin, data: UserPluginUpdate) -> UserPlugin:
    changes = data.model_dump(exclude_unset=True)
    git_secret.apply_to_entity(plugin, changes)
    for key, value in changes.items():
        setattr(plugin, key, value)
    await db.commit()
    await db.refresh(plugin)
    return plugin


async def delete(db: AsyncSession, plugin: UserPlugin) -> None:
    await db.delete(plugin)
    await db.commit()
