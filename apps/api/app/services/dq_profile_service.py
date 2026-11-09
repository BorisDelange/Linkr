"""Quality profiles: checks chosen from several rule sets, applied to one database."""

from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dq_rule_set import DqProfile, DqRunHistory
from app.schemas.dq_rule_set import DqProfileCreate, DqProfileUpdate
from app.services import attachment_service, git_secret


async def list_all(db: AsyncSession) -> list[DqProfile]:
    return list((await db.execute(select(DqProfile))).scalars().all())


async def list_for_workspace(db: AsyncSession, workspace_id: str) -> list[DqProfile]:
    result = await db.execute(select(DqProfile).where(DqProfile.workspace_id == workspace_id))
    return list(result.scalars().all())


async def get(db: AsyncSession, profile_id: str) -> DqProfile | None:
    return await db.get(DqProfile, profile_id)


async def create(db: AsyncSession, data: DqProfileCreate) -> DqProfile:
    payload = data.model_dump(exclude_none=True)
    profile = DqProfile()
    git_secret.apply_to_entity(profile, payload)
    for key, value in payload.items():
        setattr(profile, key, value)
    db.add(profile)
    await db.commit()
    await db.refresh(profile)
    return profile


async def update(db: AsyncSession, profile: DqProfile, data: DqProfileUpdate) -> DqProfile:
    changes = data.model_dump(exclude_unset=True)
    git_secret.apply_to_entity(profile, changes)
    for key, value in changes.items():
        setattr(profile, key, value)
    await db.commit()
    await db.refresh(profile)
    return profile


async def delete(db: AsyncSession, profile: DqProfile) -> None:
    from app.services import git_service
    from app.services.server_runs import runs

    profile_id = profile.id
    # A run going on would write the history of a profile that is gone.
    await runs.forget(db, ("dq_profile",), [profile_id])
    await db.delete(profile)  # cascades to its runs via FK
    await db.commit()
    await attachment_service.delete_readme_for_owner(db, "dq-profile", profile_id)
    git_service.remove_repo("dq-profiles", profile_id)


async def list_runs(db: AsyncSession, profile_id: str) -> list[DqRunHistory]:
    result = await db.execute(
        select(DqRunHistory)
        .where(DqRunHistory.profile_id == profile_id)
        .order_by(DqRunHistory.started_at.desc())
    )
    return list(result.scalars().all())


async def delete_runs(db: AsyncSession, profile_id: str) -> None:
    await db.execute(sa_delete(DqRunHistory).where(DqRunHistory.profile_id == profile_id))
    await db.commit()
