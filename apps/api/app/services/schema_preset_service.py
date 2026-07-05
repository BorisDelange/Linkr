from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.schema_preset import SchemaPreset
from app.models.user import User
from app.models.workspace_member import WorkspaceMember
from app.schemas.schema_preset import SchemaPresetSave


async def list_for_user(db: AsyncSession, user: User) -> list[SchemaPreset]:
    """Presets in the user's workspaces, plus global (workspace-less) ones."""
    if user.role == "admin":
        result = await db.execute(select(SchemaPreset))
        return list(result.scalars().all())

    member_ws = select(WorkspaceMember.workspace_id).where(
        WorkspaceMember.user_id == user.id
    )
    result = await db.execute(
        select(SchemaPreset).where(
            or_(
                SchemaPreset.workspace_id.is_(None),
                SchemaPreset.workspace_id.in_(member_ws),
            )
        )
    )
    return list(result.scalars().all())


async def get(db: AsyncSession, preset_id: str) -> SchemaPreset | None:
    return await db.get(SchemaPreset, preset_id)


async def save(db: AsyncSession, data: SchemaPresetSave) -> SchemaPreset:
    """Upsert by preset_id."""
    preset = await db.get(SchemaPreset, data.preset_id)
    if preset is None:
        preset = SchemaPreset(**data.model_dump())
        db.add(preset)
    else:
        preset.workspace_id = data.workspace_id
        preset.mapping = data.mapping
    await db.commit()
    await db.refresh(preset)
    return preset


async def delete(db: AsyncSession, preset: SchemaPreset) -> None:
    await db.delete(preset)
    await db.commit()
