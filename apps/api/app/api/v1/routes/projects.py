from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import require_project_role, ROLE_ORDER
from app.models.user import User
from app.models.workspace_member import WorkspaceMember
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
    # Require editor on the target workspace (admins bypass).
    if body.workspace_id is not None and user.role != "admin":
        member = await db.get(WorkspaceMember, (body.workspace_id, user.id))
        if member is None or ROLE_ORDER[member.role] < ROLE_ORDER["editor"]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient workspace permissions",
            )
    return await project_service.create(db, body, user)


@router.get("/{project_uid}", response_model=ProjectResponse)
async def get_project(project=Depends(require_project_role("viewer"))):
    return project


@router.patch("/{project_uid}", response_model=ProjectResponse)
async def update_project(
    body: ProjectUpdate,
    project=Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
):
    return await project_service.update(db, project, body)


@router.delete("/{project_uid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project=Depends(require_project_role("editor")),
    db: AsyncSession = Depends(get_db),
):
    await project_service.delete(db, project)
