"""Account-level settings singleton (app_settings, one row keyed 'account').

Holds the git remote for the settings versioning scope, and the setup wizard's
decision about the default data. The auth token is never stored here — it lives
per (user, host) in git_credentials, so the persisted config carries only
{url, branch}.
"""
from datetime import datetime, timezone

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


async def get_default_data(db: AsyncSession) -> dict | None:
    """What the wizard decided about the default data, or None if never asked."""
    row = await db.get(AppSettings, ACCOUNT_ID)
    return row.default_data if row else None


async def set_default_data(
    db: AsyncSession, entry_id: str, installed: bool, workspace_id: str | None
) -> dict:
    """Record the wizard's decision — including "start empty" (installed=False).

    Stored so the question is asked once per instance. The install itself runs in
    the browser (the server only clones), so this is written after the fact:
    `installed=True` means the client reported a workspace, not that the server
    verified one.
    """
    row = await get_or_create(db)
    row.default_data = {
        "entryId": entry_id,
        "installed": installed,
        "workspaceId": workspace_id,
        "decidedAt": datetime.now(timezone.utc).isoformat(),
    }
    await db.commit()
    await db.refresh(row)
    return row.default_data
