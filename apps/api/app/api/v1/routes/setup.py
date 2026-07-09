from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, make_url, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.database import get_db
from app.core.deps import get_current_user_optional
from app.core.security import hash_password
from app.models.user import User
from app.schemas.auth import (
    DbInfoResponse,
    SetupRequest,
    SetupStatusResponse,
    UserResponse,
)

router = APIRouter(prefix="/setup", tags=["setup"])


@router.get("/status", response_model=SetupStatusResponse)
async def setup_status(db: AsyncSession = Depends(get_db)):
    """Check if initial setup is needed (no users exist)."""
    result = await db.execute(select(func.count(User.id)))
    count = result.scalar_one()
    return SetupStatusResponse(needs_setup=count == 0)


@router.get("/db-info", response_model=DbInfoResponse)
async def db_info(
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """Report the database the server actually uses (configured server-side).

    Public during initial setup (the wizard shows the target DB before any user
    exists); admin-only once set up, so DB topology isn't leaked to anyone."""
    count = await db.scalar(select(func.count(User.id)))
    if count and count > 0 and (user is None or user.role != "admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin access required")
    url = make_url(settings.resolved_database_url)
    engine = url.get_backend_name()  # "sqlite", "postgresql", ...
    if engine == "sqlite":
        location = url.database or ":memory:"
    else:
        host = f"{url.host or ''}:{url.port}" if url.port else (url.host or "")
        location = f"{host}/{url.database}" if url.database else host
    return DbInfoResponse(engine=engine, location=location)


@router.post("/initialize", response_model=UserResponse)
async def setup_initialize(
    request: SetupRequest,
    db: AsyncSession = Depends(get_db),
):
    """Create the first admin user. Only works when no users exist."""
    result = await db.execute(select(func.count(User.id)))
    count = result.scalar_one()
    if count > 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Setup already completed",
        )

    user = User(
        username=request.username,
        email=request.email,
        password_hash=hash_password(request.password),
        role="admin",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user
