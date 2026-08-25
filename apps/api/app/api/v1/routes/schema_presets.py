from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
from app.models.user import User
from app.schemas.schema_preset import SchemaPresetResponse, SchemaPresetSave
from app.services import schema_preset_service

router = APIRouter(prefix="/schema-presets", tags=["schema-presets"])


@router.get("", response_model=list[SchemaPresetResponse])
async def list_schema_presets(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await schema_preset_service.list_for_user(db, user)


@router.put("/{key}", response_model=SchemaPresetResponse)
async def save_schema_preset(
    key: str,
    body: SchemaPresetSave,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # The URL names the entity by `id` like every other route. `preset_id` is
    # still accepted (service.get resolves either) so a client or a bookmark
    # predating the split keeps working.
    if key not in (body.id, body.preset_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="id in body must match the URL",
        )
    # save() upserts and can re-parent an existing preset. Authorize
    # BOTH the current workspace (so a stranger can't overwrite/steal an existing
    # preset via a known id) and the target workspace (so it can't be planted
    # somewhere the caller lacks rights), mirroring the delete handler.
    existing = await schema_preset_service.get(db, key)
    if existing is not None and existing.workspace_id is not None:
        await check_workspace_permission(db, existing.workspace_id, user, "schemas:write")
    if body.workspace_id is not None:
        await check_workspace_permission(db, body.workspace_id, user, "schemas:write")
    return await schema_preset_service.save(db, body)


@router.delete("/{key}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_schema_preset(
    key: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    preset = await schema_preset_service.get(db, key)
    if preset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if preset.workspace_id is not None:
        await check_workspace_permission(db, preset.workspace_id, user, "schemas:delete")
    await schema_preset_service.delete(db, preset)
