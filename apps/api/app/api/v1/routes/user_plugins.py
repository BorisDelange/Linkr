from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_role
from app.models.user import User
from app.models.user_plugin import UserPlugin
from app.schemas.user_plugin import (
    UserPluginCreate,
    UserPluginResponse,
    UserPluginUpdate,
)
from app.services import user_plugin_service

router = APIRouter(prefix="/user-plugins", tags=["user-plugins"])


async def _check_access(db: AsyncSession, workspace_id: str | None, user: User, min_role: str) -> None:
    """Global plugins (no workspace) are readable/writable by any authenticated
    user; workspace-scoped plugins require the matching role."""
    if workspace_id is not None:
        await check_workspace_role(db, workspace_id, user, min_role)


async def _load(db: AsyncSession, plugin_id: str, user: User, min_role: str) -> UserPlugin:
    plugin = await user_plugin_service.get(db, plugin_id)
    if plugin is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _check_access(db, plugin.workspace_id, user, min_role)
    return plugin


@router.get("", response_model=list[UserPluginResponse])
async def list_plugins(
    workspace_id: str | None = Query(default=None, alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if workspace_id is not None:
        await check_workspace_role(db, workspace_id, user, "viewer")
        return await user_plugin_service.list_for_workspace(db, workspace_id)
    # No filter: global plugins + those in workspaces the user can see.
    plugins = await user_plugin_service.list_all(db)
    visible: list[UserPlugin] = []
    for p in plugins:
        if p.workspace_id is None:
            visible.append(p)
            continue
        try:
            await check_workspace_role(db, p.workspace_id, user, "viewer")
            visible.append(p)
        except HTTPException:
            continue
    return visible


@router.post("", response_model=UserPluginResponse, status_code=status.HTTP_201_CREATED)
async def create_plugin(
    body: UserPluginCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _check_access(db, body.workspace_id, user, "editor")
    return await user_plugin_service.create(db, body)


@router.get("/{plugin_id}", response_model=UserPluginResponse)
async def get_plugin(
    plugin_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load(db, plugin_id, user, "viewer")


@router.patch("/{plugin_id}", response_model=UserPluginResponse)
async def update_plugin(
    plugin_id: str,
    body: UserPluginUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    plugin = await _load(db, plugin_id, user, "editor")
    return await user_plugin_service.update(db, plugin, body)


@router.delete("/{plugin_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_plugin(
    plugin_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    plugin = await _load(db, plugin_id, user, "editor")
    await user_plugin_service.delete(db, plugin)
