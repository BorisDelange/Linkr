"""Creator-provenance stamping shared by owner+provenance entities.

Two orthogonal axes live on these entities:
  - owner_id       — current local owner (mutable; authorization).
  - created_by*    — original author (immutable provenance snapshot).

At plain creation the author IS the authenticated owner. At import the ZIP
carries the original author's display snapshot (created_by / created_by_details)
but no meaningful local id — created_by_id from another instance is discarded.
We then try to re-link the author to a *local* account by ORCID, then email,
so a rename on this instance keeps the displayed name live; if no local user
matches, created_by_id stays NULL and the frozen snapshot is what shows.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User


def _owner_details(owner: User) -> dict:
    # affiliation/profession may be a LocalizedString dict or a legacy string;
    # both are kept verbatim (the `if v` drop also skips an empty {} / "").
    return {
        k: v
        for k, v in {
            "firstName": owner.first_name,
            "lastName": owner.last_name,
            "email": owner.email,
            "affiliation": owner.affiliation,
            "profession": owner.profession,
            "orcid": owner.orcid,
        }.items()
        if v
    }


async def _may_read_email(db: AsyncSession, caller: User | None, account: User) -> bool:
    """Whether `caller` can already read `account`'s email: their own, as an
    administrator, or in the member list of a workspace they share."""
    from app.core.permissions import has_permission
    from app.models.workspace_member import WorkspaceMember

    if caller is None:
        return False
    if caller.id == account.id or caller.role == "admin":
        return True
    workspaces = await db.scalars(select(WorkspaceMember.workspace_id).where(WorkspaceMember.user_id == account.id))
    for workspace_id in workspaces.all():
        if await has_permission(db, workspace_id, caller, "workspace-members:read"):
            return True
    return False


async def _match_local_user(db: AsyncSession, details: dict, caller: User | None) -> User | None:
    """Find a local account for an imported author, by ORCID then email. The email
    match answers only for an account whose email `caller` may already read: an
    author snapshot is not a way to look accounts up."""
    orcid = (details or {}).get("orcid")
    if orcid:
        result = await db.execute(select(User).where(User.orcid == orcid))
        user = result.scalars().first()
        if user:
            return user
    email = (details or {}).get("email")
    if email:
        result = await db.execute(select(User).where(User.email == email))
        user = result.scalars().first()
        if user and await _may_read_email(db, caller, user):
            return user
    return None


async def relink_creator_on_update(db: AsyncSession, entity, changes: dict, editor: User | None = None) -> None:
    """Re-resolve created_by_id when an update rewrites the author snapshot
    without pinning an id — a git clone re-applying the repo's metadata over a
    pointer-created record. The pointer create had no snapshot, so stamp_creator
    attributed the importing user; leaving that id in place makes the UI
    (which re-hydrates the author live from created_by_id) show the importer
    instead of the repo's real author. Same resolution as stamp_creator:
    local match by ORCID/email, else NULL and the frozen snapshot displays.
    An explicit created_by_id in the changes (author re-attribution editor)
    always wins and skips this. Without an `editor`, only an ORCID re-links."""
    if "created_by_id" in changes:
        return
    if "created_by" not in changes and "created_by_details" not in changes:
        return
    match = await _match_local_user(db, changes.get("created_by_details") or {}, editor)
    entity.created_by_id = match.id if match else None


async def stamp_creator(db: AsyncSession, entity, payload: dict, owner: User) -> None:
    """Set created_by_id / created_by / created_by_details on a new entity.

    A never-trusted payload created_by_id is ignored (a foreign instance's id).
    When the payload carries a display snapshot it's an import: keep the snapshot
    and re-link created_by_id to a local user by ORCID/email if one exists,
    else NULL. Otherwise it's a plain creation stamped from the owner.
    """
    snapshot = payload.get("created_by") or payload.get("created_by_details")
    if snapshot:
        entity.created_by = payload.get("created_by")
        entity.created_by_details = payload.get("created_by_details")
        match = await _match_local_user(db, payload.get("created_by_details") or {}, owner)
        entity.created_by_id = match.id if match else None
    else:
        full = f"{owner.first_name or ''} {owner.last_name or ''}".strip()
        entity.created_by = full or owner.username
        entity.created_by_details = _owner_details(owner)
        entity.created_by_id = owner.id
