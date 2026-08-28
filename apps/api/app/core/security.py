from datetime import datetime, timedelta, timezone

from jose import jwt
from passlib.context import CryptContext

from app.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def create_access_token(user_id: int, username: str, role: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "type": "access",
        "iat": now,
        "exp": now + timedelta(minutes=settings.access_token_expire_minutes),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def create_refresh_token(user_id: int, username: str, role: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "type": "refresh",
        "iat": now,
        "exp": now + timedelta(days=settings.refresh_token_expire_days),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def create_kernel_token(user_id: int, username: str, role: str, project_uid: str) -> str:
    """Mint the token injected into a kernel/terminal as ``LINKR_TOKEN``, for the
    client libraries (``linkr::databases()``).

    Deliberately NOT an access token. Anything the user runs in that project can
    read this value out of the environment, so it is narrowed on three axes an
    access token is not:

      * ``type="kernel"`` — ``get_current_user`` accepts only ``type="access"``,
        so this cannot call the general API (no password change, no user admin,
        no minting a longer-lived token from it).
      * ``project`` — bound to the one project whose kernel it was injected into,
        checked on every request, so it cannot read a project the script does not
        run in.
      * ``exp`` — kernel_token_expire_minutes, not 24 hours.

    It carries the acting user's identity, so the permission checks behind the
    endpoints it may reach resolve to exactly what that user could already do in
    the UI: it never widens reach, it only spares the script a hardcoded path.
    """
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "project": project_uid,
        "type": "kernel",
        "iat": now,
        "exp": now + timedelta(minutes=settings.kernel_token_expire_minutes),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def decode_token(token: str) -> dict:
    """Decode and validate a JWT token. Raises JWTError on failure."""
    return jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
