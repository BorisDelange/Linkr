from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_role
from app.models.ide_connection import IdeConnection
from app.models.project import Project
from app.models.user import User
from app.schemas.ide_connection import (
    IdeConnectionCreate,
    IdeConnectionResponse,
    IdeConnectionUpdate,
)
from app.services import ide_connection_service

router = APIRouter(prefix="/ide-connections", tags=["ide-connections"])


async def _require_project_access(
    db: AsyncSession, project_uid: str, user: User, min_role: str
) -> None:
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    if project.workspace_id is not None:
        await check_workspace_role(db, project.workspace_id, user, min_role)


async def _load(db: AsyncSession, connection_id: str, user: User, min_role: str) -> IdeConnection:
    connection = await ide_connection_service.get(db, connection_id)
    if connection is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _require_project_access(db, connection.project_uid, user, min_role)
    return connection


@router.get("", response_model=list[IdeConnectionResponse])
async def list_connections(
    project_uid: str = Query(alias="projectUid"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project_access(db, project_uid, user, "viewer")
    return await ide_connection_service.list_for_project(db, project_uid)


@router.post("", response_model=IdeConnectionResponse, status_code=status.HTTP_201_CREATED)
async def create_connection(
    body: IdeConnectionCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project_access(db, body.project_uid, user, "editor")
    return await ide_connection_service.create(db, body)


@router.get("/{connection_id}", response_model=IdeConnectionResponse)
async def get_connection(
    connection_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load(db, connection_id, user, "viewer")


@router.patch("/{connection_id}", response_model=IdeConnectionResponse)
async def update_connection(
    connection_id: str,
    body: IdeConnectionUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    connection = await _load(db, connection_id, user, "editor")
    return await ide_connection_service.update(db, connection, body)


@router.delete("/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_connection(
    connection_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    connection = await _load(db, connection_id, user, "editor")
    await ide_connection_service.delete(db, connection)


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def delete_connections_for_project(
    project_uid: str = Query(alias="projectUid"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project_access(db, project_uid, user, "editor")
    await ide_connection_service.delete_for_project(db, project_uid)
