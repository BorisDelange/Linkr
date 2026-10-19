"""Per-(user, host) git access tokens.

A token is stored once per user per remote host and reused for every repo on
that host. Git ops resolve the host from the remote URL, then look up the token
for the ACTING user — so a user never pushes with another user's credential.
Tokens are encrypted at rest (core/crypto.py) and never returned by the
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
_SCP_RE = re.compile(r'^(?:[^@/:]+@)?(?P<host>[^:/@]+):(?!/)')


def secret_context(user_id: int, host: str) -> str:
    """What a git token is sealed to: it only opens for this user and host."""
    return f"git:{user_id}:{host}"


def host_of(url: str) -> str | None:
    """Bare host of a git remote URL, lowercased, with a non-default port kept.

    Handles http(s):// and ssh:// (via the netloc) and scp-style git@host:path.
    Returns None when no host can be determined.

    The host is read from the URL as git_service will contact it (`_clean_url`),
    never from the string as written: a schemeless `gitlab.com:x@evil.com/g/r`
    is cleaned to https://…@evil.com, and a token chosen for gitlab.com would be
    injected into a request to evil.com.
    """
    from urllib.parse import urlsplit

    from app.services.git_service import _clean_url

    url = _clean_url(url or "")
    if not url:
        return None

    if "://" in url:
        try:
            parts = urlsplit(url)
            host = parts.hostname
        except ValueError:
            return None
        if not host:
            return None
        host = host.lower()
        # A user-less scp remote (`gitlab.com:group/repo`) is cleaned into
        # https://gitlab.com:group/…, whose "port" is the path: no port then.
        try:
            port = parts.port
        except ValueError:
            port = None
        # Keep an explicit non-default port so gitea.local:3000 != gitea.local:443.
        default_port = {"https": 443, "http": 80, "ssh": 22, "git": 9418}.get(parts.scheme)
        if port and port != default_port:
            return f"{host}:{port}"
        return host

    # Schemeless with an "@" after the first ":" is no scp remote git would read
    # the same way we do; refuse it rather than guess its host.
    if "@" in url.partition(":")[2]:
        return None
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
    ciphertext = crypto.encrypt(token, secret_context(user.id, host))
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
    host = (host or "").strip().lower()
    cred = await _get(db, user.id, host)
    return crypto.decrypt(cred.secret, secret_context(user.id, host)) if cred else None


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
