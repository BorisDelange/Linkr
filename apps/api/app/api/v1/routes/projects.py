from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission, require_project_permission
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.project import ProjectCreate, ProjectResponse, ProjectUpdate
from app.services import project_service

router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("", response_model=list[ProjectResponse])
async def list_projects(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await project_service.list_for_user(db, user)


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: ProjectCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Creating a project needs projects:write on the target workspace.
    if body.workspace_id is not None:
        # The imported ZIP may reference a workspace that doesn't exist on this
        # instance; reject it cleanly instead of letting the FK insert 500.
        if await db.get(Workspace, body.workspace_id) is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Workspace not found",
            )
        await check_workspace_permission(db, body.workspace_id, user, "projects:write")
    return await project_service.create(db, body, user)


@router.get("/{project_uid}", response_model=ProjectResponse)
async def get_project(project=Depends(require_project_permission("project-summary:read"))):
    return project


@router.patch("/{project_uid}", response_model=ProjectResponse)
async def update_project(
    body: ProjectUpdate,
    project=Depends(require_project_permission("project-settings:write")),
    db: AsyncSession = Depends(get_db),
):
    return await project_service.update(db, project, body)


@router.delete("/{project_uid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project=Depends(require_project_permission("project-settings:delete")),
    db: AsyncSession = Depends(get_db),
):
    await project_service.delete(db, project)
