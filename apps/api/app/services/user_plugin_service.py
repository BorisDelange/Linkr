from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.user_plugin import UserPlugin
from app.schemas.user_plugin import UserPluginCreate, UserPluginUpdate
from app.services import author_provenance, git_secret


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


async def create(db: AsyncSession, data: UserPluginCreate, owner: User) -> UserPlugin:
    payload = data.model_dump(exclude_none=True)
    # A foreign instance's created_by_id is meaningless here — never persist it;
    # stamp_creator derives the right local id (ORCID/email match, or NULL) and it
    # owns created_by / created_by_details too (it reads them from the payload, then
    # overwrites the entity), so the setattr loop's earlier assignment is harmless.
    payload.pop("created_by_id", None)
    plugin = UserPlugin()
    git_secret.apply_to_entity(plugin, payload)
    for key, value in payload.items():
        setattr(plugin, key, value)
    await author_provenance.stamp_creator(db, plugin, payload, owner)
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
