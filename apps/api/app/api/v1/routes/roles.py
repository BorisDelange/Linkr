from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_admin
from app.core.permissions import ALL_PERMISSIONS
from app.models.user import User
from app.schemas.role import RoleCreate, RoleResponse, RoleUpdate
from app.services import role_service

router = APIRouter(prefix="/roles", tags=["roles"])


@router.get("/permissions", response_model=list[str])
async def list_permissions(_admin: User = Depends(get_current_admin)):
    """The code-defined permission catalogue the UI renders the matrix from."""
    return ALL_PERMISSIONS


@router.get("", response_model=list[RoleResponse])
async def list_roles(
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    return await role_service.list_all(db)


@router.post("", response_model=RoleResponse, status_code=status.HTTP_201_CREATED)
async def create_role(
    body: RoleCreate,
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    return await role_service.create(db, body)


@router.get("/{role_id}", response_model=RoleResponse)
async def get_role(
    role_id: str,
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    role = await role_service.get(db, role_id)
    if role is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return role


@router.patch("/{role_id}", response_model=RoleResponse)
async def update_role(
    role_id: str,
    body: RoleUpdate,
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    role = await role_service.get(db, role_id)
    if role is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return await role_service.update(db, role, body)


@router.delete("/{role_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_role(
    role_id: str,
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    role = await role_service.get(db, role_id)
    if role is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    await role_service.delete(db, role)
