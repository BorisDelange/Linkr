from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import require_global_permission, require_permission
from app.models.user import User
from app.schemas.workspace import (
    WorkspaceCreate,
    WorkspaceResponse,
    WorkspaceUpdate,
)
from app.services import workspace_service

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


@router.get("", response_model=list[WorkspaceResponse])
async def list_workspaces(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await workspace_service.list_for_user(db, user)


@router.post("", response_model=WorkspaceResponse, status_code=status.HTTP_201_CREATED)
async def create_workspace(
    body: WorkspaceCreate,
    user: User = Depends(require_global_permission("workspaces:write")),
    db: AsyncSession = Depends(get_db),
):
    # Creating a workspace is a global-tier right (admin, or a role granted
    # "workspaces:write"). The creator becomes its owner (see the service).
    return await workspace_service.create(db, body, user)


@router.get(
    "/{workspace_id}",
    response_model=WorkspaceResponse,
    dependencies=[Depends(require_permission("workspace-summary:read"))],
)
async def get_workspace(workspace_id: str, db: AsyncSession = Depends(get_db)):
    workspace = await workspace_service.get(db, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return workspace


@router.patch(
    "/{workspace_id}",
    response_model=WorkspaceResponse,
    dependencies=[Depends(require_permission("workspace-settings:write"))],
)
async def update_workspace(
    workspace_id: str,
    body: WorkspaceUpdate,
    db: AsyncSession = Depends(get_db),
):
    workspace = await workspace_service.get(db, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return await workspace_service.update(db, workspace, body)


@router.delete(
    "/{workspace_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_permission("workspace-settings:delete"))],
)
async def delete_workspace(workspace_id: str, db: AsyncSession = Depends(get_db)):
    workspace = await workspace_service.get(db, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    await workspace_service.delete(db, workspace)
