from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_role
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


@router.put("/{preset_id}", response_model=SchemaPresetResponse)
async def save_schema_preset(
    preset_id: str,
    body: SchemaPresetSave,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if body.preset_id != preset_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="presetId in body must match the URL",
        )
    if body.workspace_id is not None:
        await check_workspace_role(db, body.workspace_id, user, "editor")
    return await schema_preset_service.save(db, body)


@router.delete("/{preset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_schema_preset(
    preset_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    preset = await schema_preset_service.get(db, preset_id)
    if preset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if preset.workspace_id is not None:
        await check_workspace_role(db, preset.workspace_id, user, "editor")
    await schema_preset_service.delete(db, preset)
