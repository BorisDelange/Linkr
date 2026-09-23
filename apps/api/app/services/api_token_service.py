"""Personal API tokens (``lnk_…``): mint, list, revoke, authenticate.

The secret is shown once and only its SHA-256 is stored, so a lookup by hash is
the whole verification — there is no plaintext to compare in variable time.
"""

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.api_token import ApiToken
from app.models.user import User

TOKEN_MARKER = "lnk_"
PREFIX_LENGTH = 8
LAST_USED_THROTTLE = timedelta(minutes=1)


def is_api_token(value: str) -> bool:
    return value.startswith(TOKEN_MARKER)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _aware(value: datetime | None) -> datetime | None:
    # SQLite hands timezone-aware columns back naive; they were written as UTC.
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def is_expired(token: ApiToken, now: datetime | None = None) -> bool:
    expires_at = _aware(token.expires_at)
    return expires_at is not None and expires_at <= (now or datetime.now(timezone.utc))


async def create_token(
    db: AsyncSession, user: User, name: str, expires_in_days: int | None
) -> tuple[ApiToken, str]:
    """Persist a new token for ``user``; returns the row and the plaintext secret."""
    secret = secrets.token_urlsafe(32)
    plaintext = f"{TOKEN_MARKER}{secret}"
    now = datetime.now(timezone.utc)
    token = ApiToken(
        user_id=user.id,
        name=name,
        token_hash=hash_token(plaintext),
        prefix=secret[:PREFIX_LENGTH],
        created_at=now,
        expires_at=now + timedelta(days=expires_in_days) if expires_in_days else None,
    )
    db.add(token)
    await db.commit()
    await db.refresh(token)
    return token, plaintext


async def list_tokens(db: AsyncSession, user: User) -> list[ApiToken]:
    result = await db.scalars(
        select(ApiToken)
        .where(ApiToken.user_id == user.id)
        .order_by(ApiToken.created_at.desc())
    )
    return list(result)


async def revoke_token(db: AsyncSession, user: User, token_id: str) -> ApiToken | None:
    """Revoke one of ``user``'s tokens. None when it is not theirs (or absent),
    so the caller answers 404 without revealing another user's token ids."""
    token = await db.get(ApiToken, token_id)
    if token is None or token.user_id != user.id:
        return None
    if token.revoked_at is None:
        token.revoked_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(token)
    return token


async def authenticate(db: AsyncSession, plaintext: str) -> User | None:
    """The active user a live (not revoked, not expired) token belongs to, else None.

    Stamps ``last_used_at`` at most once per LAST_USED_THROTTLE, so a chatty
    client does not turn every read into a write.
    """
    token = await db.scalar(select(ApiToken).where(ApiToken.token_hash == hash_token(plaintext)))
    now = datetime.now(timezone.utc)
    if token is None or token.revoked_at is not None or is_expired(token, now):
        return None
    user = await db.get(User, token.user_id)
    if user is None or not user.is_active:
        return None
    last_used = _aware(token.last_used_at)
    if last_used is None or now - last_used >= LAST_USED_THROTTLE:
        token.last_used_at = now
        await db.commit()
    return user
