from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import audit
from app.core.database import get_db
from app.core.security import decode_token
from app.models.user import User
from app.services import api_token_service

bearer_scheme = HTTPBearer()
optional_bearer_scheme = HTTPBearer(auto_error=False)


async def get_current_user_optional(
    credentials: HTTPAuthorizationCredentials | None = Depends(optional_bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> User | None:
    """Like get_current_user but returns None (instead of 401) when no valid
    Bearer token is present. For endpoints that are public in one state and
    authenticated in another (e.g. /setup/db-info before vs. after setup)."""
    if credentials is None:
        return None
    if api_token_service.is_api_token(credentials.credentials):
        user = await api_token_service.authenticate(db, credentials.credentials)
        if user is not None:
            audit.set_actor(user.id, user.username, "api_key")
        return user
    try:
        payload = decode_token(credentials.credentials)
        if payload.get("type") != "access":
            return None
        user_id = int(payload["sub"])
    except (JWTError, KeyError, ValueError):
        return None
    user = await db.get(User, user_id)
    if not user or not user.is_active:
        return None
    audit.set_actor(user.id, user.username, "web")
    return user


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Resolve the Bearer credential to a User: a personal API token (``lnk_…``)
    or a session access JWT. Both act with the user's own permissions."""
    if api_token_service.is_api_token(credentials.credentials):
        return await _api_token_user(credentials.credentials, db)
    return await get_session_user(credentials, db)


async def _api_token_user(token: str, db: AsyncSession) -> User:
    user = await api_token_service.authenticate(db, token)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid, revoked or expired API token",
        )
    audit.set_actor(user.id, user.username, "api_key")
    return user


async def get_session_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Like get_current_user but refuses API tokens: only a session access JWT.

    Guards the token-management routes, so a leaked API token can neither mint
    new ones nor list or revoke its siblings to hide itself.
    """
    try:
        payload = decode_token(credentials.credentials)
        if payload.get("type") != "access":
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token type",
            )
        user_id = int(payload["sub"])
    except (JWTError, KeyError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )

    user = await db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or inactive",
        )
    audit.set_actor(user.id, user.username, "web")
    return user


async def get_kernel_user(
    project_uid: str,
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Authenticate a request from a script running inside a kernel (the R/Python
    client libraries), for endpoints under ``/projects/{project_uid}/``.

    Accepts EITHER a normal access token (a user calling the same endpoint from the
    app) or a kernel token (``create_kernel_token``). A kernel token additionally
    carries the project it was minted for, and is refused against any other one —
    without that check a token lifted from one project's environment would read
    every project its owner can reach, which is exactly the widening a scoped token
    exists to prevent.

    Returning the User means the endpoint's own permission checks still run: the
    token authenticates, it never authorises. A personal API token counts as an
    access token here, as it does everywhere else.
    """
    if api_token_service.is_api_token(credentials.credentials):
        return await _api_token_user(credentials.credentials, db)
    try:
        payload = decode_token(credentials.credentials)
        token_type = payload.get("type")
        if token_type not in ("access", "kernel"):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token type"
            )
        if token_type == "kernel" and payload.get("project") != project_uid:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This token is scoped to another project",
            )
        user_id = int(payload["sub"])
    except (JWTError, KeyError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )

    user = await db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found or inactive",
        )
    audit.set_actor(user.id, user.username, "kernel" if token_type == "kernel" else "web")
    return user


async def get_current_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return user
