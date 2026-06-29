from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import hash_password
from app.models.user import User
from app.schemas.auth import SetupRequest, SetupStatusResponse, UserResponse

router = APIRouter(prefix="/setup", tags=["setup"])


@router.get("/status", response_model=SetupStatusResponse)
async def setup_status(db: AsyncSession = Depends(get_db)):
    """Check if initial setup is needed (no users exist)."""
    result = await db.execute(select(func.count(User.id)))
    count = result.scalar_one()
    return SetupStatusResponse(needs_setup=count == 0)


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
