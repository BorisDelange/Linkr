from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from jose import JWTError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth_providers import get_auth_provider
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import ALL_PERMISSIONS
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
)
from app.models.role import Role
from app.models.user import User
from app.schemas.auth import (
    LoginRequest,
    MeResponse,
    RefreshRequest,
    TokenResponse,
    UserResponse,
)
from app.schemas.user import ProfileUpdate

router = APIRouter(prefix="/auth", tags=["auth"])


def _issue_tokens(user: User) -> TokenResponse:
    return TokenResponse(
        access_token=create_access_token(user.id, user.username, user.role),
        refresh_token=create_refresh_token(user.id, user.username, user.role),
        user=UserResponse.model_validate(user),
    )


@router.post("/login", response_model=TokenResponse)
async def login(request: LoginRequest, db: AsyncSession = Depends(get_db)):
    """Authenticate via the configured provider and return JWT tokens."""
    user = await get_auth_provider().authenticate(
        request.username, request.password, db
    )
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Account is disabled",
        )

    user.last_login = datetime.now(timezone.utc)
    await db.commit()
    return _issue_tokens(user)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(request: RefreshRequest, db: AsyncSession = Depends(get_db)):
    """Exchange a refresh token for new access + refresh tokens."""
    try:
        payload = decode_token(request.refresh_token)
        if payload.get("type") != "refresh":
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token type",
            )
        user_id = int(payload["sub"])
    except (JWTError, KeyError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token",
        )

    user = await db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or inactive",
        )
    return _issue_tokens(user)


@router.post("/logout")
async def logout(user: User = Depends(get_current_user)):
    """Logout (stateless — client discards tokens)."""
    return {"ok": True}


async def _build_me(user: User, db: AsyncSession) -> MeResponse:
    if user.role == "admin":
        permissions = ALL_PERMISSIONS
    else:
        role = await db.scalar(select(Role).where(Role.name == user.role))
        permissions = (role.permissions if role else []) or []
    return MeResponse(
        id=user.id,
        username=user.username,
        email=user.email,
        role=user.role,
        is_active=user.is_active,
        permissions=permissions,
        first_name=user.first_name,
        last_name=user.last_name,
        affiliation=user.affiliation,
        profession=user.profession,
        orcid=user.orcid,
        preferences=user.preferences or {},
    )


@router.get("/me", response_model=MeResponse)
async def me(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return the current user + the global-tier permissions their role grants
    (admins get everything). The UI uses these to gate admin pages/tools."""
    return await _build_me(user, db)


@router.patch("/me", response_model=MeResponse)
async def update_me(
    body: ProfileUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Self-service profile update. Only the user's own editable fields —
    role/is_active/username/password are deliberately not accepted here."""
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(user, key, value)
    await db.commit()
    await db.refresh(user)
    return await _build_me(user, db)
