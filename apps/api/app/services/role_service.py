from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.permissions import ALL_PERMISSIONS
from app.models.role import Role
from app.models.workspace_member import WorkspaceMember
from app.schemas.role import RoleCreate, RoleUpdate


def _validate_permissions(permissions: list[str]) -> None:
    unknown = [p for p in permissions if p not in ALL_PERMISSIONS]
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown permissions: {', '.join(unknown)}",
        )


async def list_all(db: AsyncSession) -> list[Role]:
    result = await db.execute(select(Role))
    return list(result.scalars().all())


async def get(db: AsyncSession, role_id: str) -> Role | None:
    return await db.get(Role, role_id)


async def create(db: AsyncSession, data: RoleCreate) -> Role:
    exists = await db.scalar(select(Role).where(Role.name == data.name))
    if exists is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Role name already exists"
        )
    _validate_permissions(data.permissions)
    role = Role(**data.model_dump(exclude_none=True), is_system=False)
    db.add(role)
    await db.commit()
    await db.refresh(role)
    return role


async def update(db: AsyncSession, role: Role, data: RoleUpdate) -> Role:
    changes = data.model_dump(exclude_unset=True)
    if "permissions" in changes:
        _validate_permissions(changes["permissions"])
    for key, value in changes.items():
        setattr(role, key, value)
    await db.commit()
    await db.refresh(role)
    return role


async def delete(db: AsyncSession, role: Role) -> None:
    if role.is_system:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="System roles cannot be deleted",
        )
    in_use = await db.scalar(
        select(WorkspaceMember).where(WorkspaceMember.role == role.name)
    )
    if in_use is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Role is still assigned to members",
        )
    await db.delete(role)
    await db.commit()
