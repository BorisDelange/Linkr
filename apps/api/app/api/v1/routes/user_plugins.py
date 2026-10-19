import json

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
from app.models.user import User
from app.models.user_plugin import UserPlugin
from app.schemas.user_plugin import (
    UserPluginCreate,
    UserPluginResponse,
    UserPluginUpdate,
)
from app.services import change_tracking, notification_service, user_plugin_service

router = APIRouter(prefix="/user-plugins", tags=["user-plugins"])


async def _check_access(db: AsyncSession, workspace_id: str, user: User, permission: str) -> None:
    """Plugins are always workspace-scoped, so access is the workspace role."""
    await check_workspace_permission(db, workspace_id, user, permission)


async def _load(db: AsyncSession, plugin_id: str, user: User, permission: str) -> UserPlugin:
    plugin = await user_plugin_service.get(db, plugin_id)
    if plugin is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _check_access(db, plugin.workspace_id, user, permission)
    return plugin


# --- Notifications (writes by an external client, e.g. an agent over MCP) ---

def _label(plugin: UserPlugin) -> dict | str:
    """The plugin's name lives in its own plugin.json manifest, not in a column."""
    try:
        name = json.loads(plugin.files.get("plugin.json", "")).get("name")
    except (ValueError, AttributeError):
        name = None
    return name if isinstance(name, (dict, str)) and name else plugin.entity_id or plugin.id


def _file_change(old: dict, new: dict) -> tuple[str, str] | None:
    """(action, filename) when a files write touched exactly one file."""
    touched = [
        ("created" if f not in old else "deleted" if f not in new else "updated", f)
        for f in sorted(old.keys() | new.keys())
        if old.get(f) != new.get(f)
    ]
    return touched[0] if len(touched) == 1 else None


async def _notify(
    db: AsyncSession,
    request: Request,
    user: User,
    action: str,
    plugin: UserPlugin,
    *,
    file: tuple[str, str] | None = None,
) -> None:
    """A change to a plugin or, with `file` = (action, filename), to one of its
    files. Plugins have no project: the workspace travels in `detail`."""
    detail: dict = {"workspaceId": plugin.workspace_id}
    if file is not None:
        detail.update(part="file", action=file[0], name=file[1])
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request), action=action,
        entity_type="user_plugin", entity_id=plugin.id, project_uid=None,
        label=_label(plugin), detail=detail,
    )


@router.get("", response_model=list[UserPluginResponse])
async def list_plugins(
    workspace_id: str | None = Query(default=None, alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if workspace_id is not None:
        await check_workspace_permission(db, workspace_id, user, "plugins:read")
        return await user_plugin_service.list_for_workspace(db, workspace_id)
    # No filter: every plugin in a workspace the user can see.
    plugins = await user_plugin_service.list_all(db)
    visible: list[UserPlugin] = []
    for p in plugins:
        try:
            await check_workspace_permission(db, p.workspace_id, user, "plugins:read")
            visible.append(p)
        except HTTPException:
            continue
    return visible


@router.post("", response_model=UserPluginResponse, status_code=status.HTTP_201_CREATED)
async def create_plugin(
    body: UserPluginCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _check_access(db, body.workspace_id, user, "plugins:write")
    plugin = await user_plugin_service.create(db, body, user)
    await _notify(db, request, user, "created", plugin)
    return plugin


@router.get("/{plugin_id}", response_model=UserPluginResponse)
async def get_plugin(
    plugin_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load(db, plugin_id, user, "plugins:read")


@router.patch("/{plugin_id}", response_model=UserPluginResponse)
async def update_plugin(
    plugin_id: str,
    body: UserPluginUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    plugin = await _load(db, plugin_id, user, "plugins:write")
    before = change_tracking.changed_values(plugin, body.model_dump(exclude_unset=True))
    plugin = await user_plugin_service.update(db, plugin, body)
    if before:
        only_files = before.keys() == {"files"}
        file = _file_change(before["files"] or {}, plugin.files or {}) if only_files else None
        await _notify(db, request, user, "updated", plugin, file=file)
    return plugin


@router.delete("/{plugin_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_plugin(
    plugin_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    plugin = await _load(db, plugin_id, user, "plugins:delete")
    await user_plugin_service.delete(db, plugin)
    await _notify(db, request, user, "deleted", plugin)
