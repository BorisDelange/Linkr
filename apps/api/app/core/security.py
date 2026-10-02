import gzip
from datetime import datetime, timedelta, timezone
from functools import cache
from pathlib import Path

from jose import jwt
from passlib.context import CryptContext

from app.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


# bcrypt hashes only the first 72 bytes: anything past them would be accepted
# and silently ignored.
PASSWORD_MAX_BYTES = 72
_COMMON_PASSWORDS = Path(__file__).parent / "data" / "common-passwords.txt.gz"


@cache
def _common_passwords() -> frozenset[str]:
    with gzip.open(_COMMON_PASSWORDS, "rt", encoding="utf-8") as f:
        return frozenset(line.rstrip("\n") for line in f)


def password_policy_error(password: str, username: str) -> dict | None:
    """Why `password` may not be set for `username` — `{code, message}`, the
    detail of the 422 the caller raises, which the front translates by `code` —
    or None when it may."""
    min_length = settings.password_min_length
    if len(password) < min_length:
        return {"code": "password_too_short", "minLength": min_length,
                "message": f"The password must be at least {min_length} characters."}
    if len(password.encode()) > PASSWORD_MAX_BYTES:
        return {"code": "password_too_long", "maxBytes": PASSWORD_MAX_BYTES,
                "message": f"The password must be at most {PASSWORD_MAX_BYTES} bytes."}
    if password.strip().lower() == username.strip().lower():
        return {"code": "password_is_username", "message": "The password must not be the username."}
    if password.lower() in _common_passwords():
        return {"code": "password_common", "message": "This password is among the most commonly used ones."}
    return None


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def set_password(user, password: str) -> None:
    """Hash `password` onto `user` and end the sessions issued before it."""
    user.password_hash = hash_password(password)
    user.password_changed_at = datetime.now(timezone.utc)


def predates_password_change(payload: dict, user) -> bool:
    """Whether a session token was issued before `user` last set a password.

    `iat` has whole-second resolution, so the change is floored to its second:
    the tokens handed to the caller right after the change, in the same second,
    must stay valid."""
    changed = user.password_changed_at
    if changed is None:
        return False
    if changed.tzinfo is None:
        changed = changed.replace(tzinfo=timezone.utc)
    return int(payload.get("iat", 0)) < int(changed.timestamp())


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


def create_kernel_token(user_id: int, username: str, role: str, project_uid: str, *, via: str) -> str:
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
      * ``via`` — how the caller that started the kernel authenticated. Only a
        ``"web"`` one may fetch database recipes: a kernel started by an API key
        runs an agent's code, which must not get the decrypted password.

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
        "via": via,
        "type": "kernel",
        "iat": now,
        "exp": now + timedelta(minutes=settings.kernel_token_expire_minutes),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def decode_token(token: str) -> dict:
    """Decode and validate a JWT token. Raises JWTError on failure."""
    return jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
