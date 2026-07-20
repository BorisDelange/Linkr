"""Account-level settings singleton (app_settings, one row keyed 'account').

Currently holds only the git remote for the settings versioning scope. The auth
token is never stored here — it lives per (user, host) in git_credentials, so the
persisted config carries only {url, branch}.
"""
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.app_settings import AppSettings
from app.services import git_secret

ACCOUNT_ID = "account"


async def get_or_create(db: AsyncSession) -> AppSettings:
    row = await db.get(AppSettings, ACCOUNT_ID)
    if row is None:
        row = AppSettings(id=ACCOUNT_ID, git_remote_config=None)
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return row


async def set_git_remote_config(
    db: AsyncSession, config: dict | None
) -> tuple[AppSettings, str | None]:
    """Persist the token-stripped {url, branch}; return (row, plaintext_token) so the
    caller can store the token per (user, host). An empty config clears the remote."""
    stripped, token = git_secret.split_config(config)
    row = await get_or_create(db)
    row.git_remote_config = stripped or None
    await db.commit()
    await db.refresh(row)
    return row, token
