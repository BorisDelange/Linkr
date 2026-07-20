"""Per-(user, host) git access tokens.

A token is stored once per user per remote host and reused for every repo on
that host. Git ops resolve the host from the remote URL, then look up the token
for the ACTING user — so a user never pushes with another user's credential.
Tokens are encrypted at rest with Fernet (see crypto) and never returned by the
API.
"""

import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import crypto
from app.models.git_credential import GitCredential
from app.models.user import User

# scp-style ssh remote: [user@]host:path (no scheme). The host is between an
# optional "user@" and the first ":". Rejects a leading "/" (that's a path, not scp).
_SCP_RE = re.compile(r'^(?:[^@/]+@)?(?P<host>[^:/]+):(?!/)')


def host_of(url: str) -> str | None:
    """Bare host of a git remote URL, lowercased, with a non-default port kept.

    Handles http(s):// and ssh:// (via the netloc) and scp-style git@host:path.
    Returns None when no host can be determined.
    """
    from urllib.parse import urlsplit

    url = (url or "").strip()
    if not url:
        return None

    if "://" in url:
        parts = urlsplit(url)
        host = parts.hostname
        if not host:
            return None
        host = host.lower()
        # Keep an explicit non-default port so gitea.local:3000 != gitea.local:443.
        default_port = {"https": 443, "http": 80, "ssh": 22, "git": 9418}.get(parts.scheme)
        if parts.port and parts.port != default_port:
            return f"{host}:{parts.port}"
        return host

    m = _SCP_RE.match(url)
    if m:
        return m.group("host").lower()
    return None


async def _get(db: AsyncSession, user_id: int, host: str) -> GitCredential | None:
    result = await db.execute(
        select(GitCredential).where(
            GitCredential.user_id == user_id, GitCredential.host == host
        )
    )
    return result.scalar_one_or_none()


async def set_token(db: AsyncSession, user: User, host: str, token: str | None) -> None:
    """Upsert (or clear) the acting user's token for `host`. An empty token
    deletes the credential (the user unlinked/cleared it)."""
    host = (host or "").strip().lower()
    if not host:
        return
    existing = await _get(db, user.id, host)
    if not token:
        if existing is not None:
            await db.delete(existing)
            await db.commit()
        return
    ciphertext = crypto.encrypt(token)
    if existing is None:
        db.add(GitCredential(user_id=user.id, host=host, secret=ciphertext))
    else:
        existing.secret = ciphertext
    await db.commit()


async def set_token_for_url(db: AsyncSession, user: User, url: str, token: str | None) -> None:
    """Store the acting user's token under the host resolved from `url`."""
    host = host_of(url)
    if host:
        await set_token(db, user, host, token)


async def token_for_host(db: AsyncSession, user: User, host: str) -> str | None:
    cred = await _get(db, user.id, (host or "").strip().lower())
    return crypto.decrypt(cred.secret) if cred else None


async def token_for_url(db: AsyncSession, user: User, url: str | None) -> str | None:
    """The acting user's token for the host of `url` (None if no host / no token)."""
    if not url:
        return None
    host = host_of(url)
    if not host:
        return None
    return await token_for_host(db, user, host)


async def has_token_for_host(db: AsyncSession, user: User, host: str) -> bool:
    return (await _get(db, user.id, (host or "").strip().lower())) is not None
