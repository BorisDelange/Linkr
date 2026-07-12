from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password
from app.models.user import User
from app.schemas.user import UserCreate, UserUpdate


async def list_all(db: AsyncSession) -> list[User]:
    result = await db.execute(select(User))
    return list(result.scalars().all())


async def get(db: AsyncSession, user_id: int) -> User | None:
    return await db.get(User, user_id)


async def _active_admin_count(db: AsyncSession) -> int:
    return await db.scalar(
        select(func.count())
        .select_from(User)
        .where(User.role == "admin", User.is_active.is_(True))
    )


async def create(db: AsyncSession, data: UserCreate) -> User:
    exists = await db.scalar(select(User).where(User.username == data.username))
    if exists is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Username already exists"
        )
    payload = data.model_dump(exclude={"password"})
    user = User(**payload, password_hash=hash_password(data.password))
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def update(db: AsyncSession, user: User, data: UserUpdate) -> User:
    changes = data.model_dump(exclude_unset=True, exclude={"password"})
    # Guard against demoting/deactivating the last remaining admin.
    demoting = changes.get("role") not in (None, "admin") and user.role == "admin"
    deactivating = changes.get("is_active") is False and user.role == "admin"
    if (demoting or deactivating) and await _active_admin_count(db) <= 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot remove the last administrator",
        )
    # Renaming keeps the same user id, so memberships/roles (keyed on users.id)
    # follow automatically; only enforce username uniqueness.
    new_username = changes.get("username")
    if new_username is not None and new_username != user.username:
        clash = await db.scalar(select(User).where(User.username == new_username))
        if clash is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="Username already exists"
            )
    for key, value in changes.items():
        setattr(user, key, value)
    if data.password is not None:
        user.password_hash = hash_password(data.password)
    await db.commit()
    await db.refresh(user)
    return user


async def delete(db: AsyncSession, user: User) -> None:
    if user.role == "admin" and await _active_admin_count(db) <= 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete the last administrator",
        )
    await db.delete(user)
    await db.commit()
