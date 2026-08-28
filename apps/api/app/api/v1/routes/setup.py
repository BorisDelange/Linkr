from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, make_url, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.database import get_db
from app.core.deps import get_current_admin, get_current_user_optional
from app.core.security import hash_password
from app.models.user import User
from app.schemas.auth import (
    DbInfoResponse,
    DefaultDataRequest,
    DefaultDataResponse,
    SetupRequest,
    SetupStatusResponse,
    UserResponse,
)
from app.services import app_settings_service

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


@router.get("/default-data", response_model=DefaultDataResponse)
async def get_default_data(
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """What this instance decided about the default data.

    Read by the wizard (before any user exists) and by the app on load, which is
    how the browser-side seed knows to stay out of the way in server mode. Public
    during setup for the same reason `db-info` is, and it exposes nothing
    sensitive: an entry id and a boolean.
    """
    count = await db.scalar(select(func.count(User.id)))
    if count and count > 0 and user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Authentication required")
    stored = await app_settings_service.get_default_data(db) or {}
    return DefaultDataResponse(
        entry_id=stored.get("entryId"),
        decided_at=stored.get("decidedAt"),
        installed=bool(stored.get("installed")),
        workspace_id=stored.get("workspaceId"),
    )


@router.post("/default-data", response_model=DefaultDataResponse)
async def record_default_data(
    request: DefaultDataRequest,
    user: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Record the wizard's decision, once the install it describes has run.

    Admin-only, and written *after* the fact: the catalog install runs in the
    browser (the server's part is the clone alone), so this reports an outcome
    rather than triggering one.
    """
    stored = await app_settings_service.set_default_data(
        db, request.entry_id, request.installed, request.workspace_id
    )
    return DefaultDataResponse(
        entry_id=stored.get("entryId"),
        decided_at=stored.get("decidedAt"),
        installed=bool(stored.get("installed")),
        workspace_id=stored.get("workspaceId"),
    )
