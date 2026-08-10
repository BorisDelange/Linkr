from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dq_rule_set import DqCustomCheck, DqRuleSet, DqRunHistory
from app.services import attachment_service, git_secret
from app.schemas.dq_rule_set import (
    DqCustomCheckCreate,
    DqCustomCheckUpdate,
    DqRuleSetCreate,
    DqRuleSetUpdate,
    DqRunHistoryCreate,
    DqRunHistoryUpdate,
)


# --- Rule sets -------------------------------------------------------------

async def list_all(db: AsyncSession) -> list[DqRuleSet]:
    result = await db.execute(select(DqRuleSet))
    return list(result.scalars().all())


async def list_for_workspace(db: AsyncSession, workspace_id: str) -> list[DqRuleSet]:
    result = await db.execute(
        select(DqRuleSet).where(DqRuleSet.workspace_id == workspace_id)
    )
    return list(result.scalars().all())


async def get(db: AsyncSession, rule_set_id: str) -> DqRuleSet | None:
    return await db.get(DqRuleSet, rule_set_id)


async def create(db: AsyncSession, data: DqRuleSetCreate) -> DqRuleSet:
    payload = data.model_dump(exclude_none=True)
    rule_set = DqRuleSet()
    git_secret.apply_to_entity(rule_set, payload)
    for key, value in payload.items():
        setattr(rule_set, key, value)
    db.add(rule_set)
    await db.commit()
    await db.refresh(rule_set)
    return rule_set


async def update(
    db: AsyncSession, rule_set: DqRuleSet, data: DqRuleSetUpdate
) -> DqRuleSet:
    changes = data.model_dump(exclude_unset=True)
    git_secret.apply_to_entity(rule_set, changes)
    for key, value in changes.items():
        setattr(rule_set, key, value)
    await db.commit()
    await db.refresh(rule_set)
    return rule_set


async def delete(db: AsyncSession, rule_set: DqRuleSet) -> None:
    rule_set_id = rule_set.id
    await db.delete(rule_set)  # cascades to checks via FK
    await db.commit()
    # The README attachments' owner is polymorphic (no FK), so clean them here.
    await attachment_service.delete_readme_for_owner(db, "dq-rule-set", rule_set_id)


# --- Custom checks ---------------------------------------------------------

async def list_checks(db: AsyncSession, rule_set_id: str) -> list[DqCustomCheck]:
    result = await db.execute(
        select(DqCustomCheck).where(DqCustomCheck.rule_set_id == rule_set_id)
    )
    return list(result.scalars().all())


async def get_check(db: AsyncSession, check_id: str) -> DqCustomCheck | None:
    return await db.get(DqCustomCheck, check_id)


async def create_check(db: AsyncSession, data: DqCustomCheckCreate) -> DqCustomCheck:
    check = DqCustomCheck(**data.model_dump(exclude_none=True))
    db.add(check)
    await db.commit()
    await db.refresh(check)
    return check


async def update_check(
    db: AsyncSession, check: DqCustomCheck, data: DqCustomCheckUpdate
) -> DqCustomCheck:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(check, key, value)
    await db.commit()
    await db.refresh(check)
    return check


async def delete_check(db: AsyncSession, check: DqCustomCheck) -> None:
    await db.delete(check)
    await db.commit()


async def delete_checks_for_rule_set(db: AsyncSession, rule_set_id: str) -> None:
    await db.execute(
        sa_delete(DqCustomCheck).where(DqCustomCheck.rule_set_id == rule_set_id)
    )
    await db.commit()


# --- Run history -----------------------------------------------------------

async def list_runs(db: AsyncSession, rule_set_id: str) -> list[DqRunHistory]:
    result = await db.execute(
        select(DqRunHistory)
        .where(DqRunHistory.rule_set_id == rule_set_id)
        .order_by(DqRunHistory.started_at.desc())
    )
    return list(result.scalars().all())


async def get_run(db: AsyncSession, run_id: str) -> DqRunHistory | None:
    return await db.get(DqRunHistory, run_id)


async def create_run(db: AsyncSession, data: DqRunHistoryCreate) -> DqRunHistory:
    payload = data.model_dump(exclude_none=True)
    # Idempotent: the client may re-send the same run id (e.g. running → success).
    run = await db.get(DqRunHistory, data.id)
    if run is None:
        run = DqRunHistory()
    for key, value in payload.items():
        setattr(run, key, value)
    db.add(run)
    await db.commit()
    await db.refresh(run)
    return run


async def update_run(
    db: AsyncSession, run: DqRunHistory, data: DqRunHistoryUpdate
) -> DqRunHistory:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(run, key, value)
    await db.commit()
    await db.refresh(run)
    return run


async def delete_run(db: AsyncSession, run: DqRunHistory) -> None:
    await db.delete(run)
    await db.commit()


async def delete_runs_for_rule_set(db: AsyncSession, rule_set_id: str) -> None:
    await db.execute(
        sa_delete(DqRunHistory).where(DqRunHistory.rule_set_id == rule_set_id)
    )
    await db.commit()
