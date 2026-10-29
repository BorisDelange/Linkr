"""Merge / pull requests opened from Linkr (plan §6, §9.4): the branch pushed,
the request opened on the forge with the user's token, and the row that lets the
versioning panel list them with their state."""

import re
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.git_proposal import GitProposal
from app.services import forge_service


def proposal_branch(username: str, now: datetime | None = None) -> str:
    """`linkr/<user>/<yyyymmdd-hhmmss>`: who proposed it and when, a valid ref."""
    who = re.sub(r"[^A-Za-z0-9._-]+", "-", username or "user").strip("-.") or "user"
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y%m%d-%H%M%S")
    return f"linkr/{who}/{stamp}"


async def record(
    db: AsyncSession, *, scope: str, entity_id: str, branch: str, target_branch: str,
    forge: str, proposal: forge_service.Proposal, title: str, author_id: int | None,
) -> GitProposal:
    row = GitProposal(
        scope=scope, entity_id=entity_id, branch=branch, target_branch=target_branch, forge=forge,
        number=proposal.number, url=proposal.url, title=title, state=proposal.state, author_id=author_id,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def list_refreshed(
    db: AsyncSession, scope: str, entity_id: str, remote_url: str | None, token: str | None,
) -> list[GitProposal]:
    """The entity's proposals, newest first, the open ones re-read from the forge
    (best effort: an unreachable forge leaves the last known state)."""
    rows = list((await db.execute(
        select(GitProposal)
        .where(GitProposal.scope == scope, GitProposal.entity_id == entity_id)
        .order_by(GitProposal.id.desc())
    )).scalars().all())
    changed = False
    for row in rows:
        if row.state != "open" or not remote_url:
            continue
        try:
            fresh = await forge_service.read_proposal(remote_url, token, row.number)
        except Exception:  # noqa: BLE001 — the forge being down must not hide the list
            continue
        if fresh.state != row.state:
            row.state = fresh.state
            changed = True
    if changed:
        await db.commit()
    return rows
