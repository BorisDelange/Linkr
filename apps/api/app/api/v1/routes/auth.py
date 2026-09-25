from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from jose import JWTError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth_providers import get_auth_provider
from app.core.database import get_db
from app.core.deps import get_current_user, get_session_user
from app.core.permissions import ALL_PERMISSIONS
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
)
from app.models.role import Role
from app.models.user import User
from app.schemas.api_token import ApiTokenCreate, ApiTokenCreated, ApiTokenResponse
from app.schemas.auth import (
    LoginRequest,
    MeResponse,
    RefreshRequest,
    TokenResponse,
    UserResponse,
)
from app.schemas.audit import AuditPage
from app.schemas.data_source import DatabaseLoginEntry
from app.schemas.user import ProfileUpdate
from app.services import api_token_service, database_credential_service

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
    """Logout: the client discards its tokens; the server forgets the user's
    session-only database logins."""
    database_credential_service.forget_session_logins(user.id)
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


# Personal API tokens. All three require a session JWT (get_session_user): an API
# token cannot mint, list or revoke tokens.


@router.get("/api-tokens", response_model=list[ApiTokenResponse])
async def list_api_tokens(
    user: User = Depends(get_session_user),
    db: AsyncSession = Depends(get_db),
):
    return await api_token_service.list_tokens(db, user)


@router.post("/api-tokens", response_model=ApiTokenCreated, status_code=status.HTTP_201_CREATED)
async def create_api_token(
    body: ApiTokenCreate,
    user: User = Depends(get_session_user),
    db: AsyncSession = Depends(get_db),
):
    token, plaintext = await api_token_service.create_token(
        db, user, body.name, body.expires_in_days
    )
    return ApiTokenCreated(**ApiTokenResponse.model_validate(token).model_dump(), token=plaintext)


@router.delete("/api-tokens/{token_id}", response_model=ApiTokenResponse)
async def revoke_api_token(
    token_id: str,
    user: User = Depends(get_session_user),
    db: AsyncSession = Depends(get_db),
):
    token = await api_token_service.revoke_token(db, user, token_id)
    if token is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="API token not found")
    return token


@router.get("/database-logins", response_model=list[DatabaseLoginEntry])
async def list_database_logins(
    user: User = Depends(get_session_user),
    db: AsyncSession = Depends(get_db),
):
    """The acting user's own logins to external databases — never a password."""
    return [DatabaseLoginEntry(**entry) for entry in await database_credential_service.list_for_user(db, user.id)]


@router.get("/my-activity", response_model=AuditPage)
async def my_activity(
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    sort: str | None = None,
    desc: bool = True,
    filters: str | None = None,
    user: User = Depends(get_session_user),
):
    """The acting user's own access-log entries."""
    from app.api.v1.routes.audit_log import parse_filters, read_page

    return await read_page(limit, offset, sort, desc, parse_filters(filters), user_id=user.id)
