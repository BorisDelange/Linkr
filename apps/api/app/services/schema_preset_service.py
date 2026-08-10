from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.schema_preset import SchemaPreset
from app.models.user import User
from app.models.workspace_member import WorkspaceMember
from app.schemas.schema_preset import SchemaPresetSave
from app.services import attachment_service, git_secret


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


async def list_for_workspace(
    db: AsyncSession, workspace_id: str
) -> list[SchemaPreset]:
    result = await db.execute(
        select(SchemaPreset).where(SchemaPreset.workspace_id == workspace_id)
    )
    return list(result.scalars().all())


async def get(db: AsyncSession, preset_id: str) -> SchemaPreset | None:
    return await db.get(SchemaPreset, preset_id)


async def save(db: AsyncSession, data: SchemaPresetSave) -> SchemaPreset:
    """Upsert by preset_id.

    The whole payload is applied on both branches so a git-link save (which comes
    through this PUT, not a PATCH) persists git_remote_config; git_secret strips
    and encrypts any authToken. The earlier update branch dropped git_remote_config.
    """
    payload = data.model_dump()
    preset = await db.get(SchemaPreset, data.preset_id)
    if preset is None:
        # A None created_at (fresh create / legacy file) must not override the
        # DateTime column's server_default with NULL — drop it so it stamps now.
        if payload.get("created_at") is None:
            payload.pop("created_at", None)
        preset = SchemaPreset()
        git_secret.apply_to_entity(preset, payload)
        for key, value in payload.items():
            setattr(preset, key, value)
        db.add(preset)
    else:
        git_secret.apply_to_entity(preset, payload)
        # preset_id is the PK — never reassign it on update. created_at is the
        # element's original creation date — never move it on a re-save.
        payload.pop("preset_id", None)
        payload.pop("created_at", None)
        for key, value in payload.items():
            setattr(preset, key, value)
    await db.commit()
    await db.refresh(preset)
    return preset


async def delete(db: AsyncSession, preset: SchemaPreset) -> None:
    preset_id = preset.preset_id
    await db.delete(preset)
    await db.commit()
    # The README attachments' owner is polymorphic (no FK), so clean them here.
    await attachment_service.delete_readme_for_owner(db, "schema-preset", preset_id)
