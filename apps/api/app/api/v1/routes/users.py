from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_admin, get_current_user
from app.models.user import User
from app.schemas.user import (
    UserCreate,
    UserDirectoryEntry,
    UserResponse,
    UserUpdate,
)
from app.services import user_service

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/directory", response_model=list[UserDirectoryEntry])
async def user_directory(
    _user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Minimal id+username list for member pickers. Available to any authenticated
    user (a workspace/project owner needs it to add members without the admin-only
    full user list); exposes no email, role, or other sensitive fields."""
    return await user_service.list_all(db)


@router.get("", response_model=list[UserResponse])
async def list_users(
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    return await user_service.list_all(db)


@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    body: UserCreate,
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    return await user_service.create(db, body)


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(
    user_id: int,
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    user = await user_service.get(db, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return user


@router.patch("/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: int,
    body: UserUpdate,
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    user = await user_service.get(db, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return await user_service.update(db, user, body)


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: int,
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    user = await user_service.get(db, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    await user_service.delete(db, user)
