from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dq_rule_set import DqCustomCheck, DqRuleSet
from app.schemas.dq_rule_set import (
    DqCustomCheckCreate,
    DqCustomCheckUpdate,
    DqRuleSetCreate,
    DqRuleSetUpdate,
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
    rule_set = DqRuleSet(**data.model_dump(exclude_none=True))
    db.add(rule_set)
    await db.commit()
    await db.refresh(rule_set)
    return rule_set


async def update(
    db: AsyncSession, rule_set: DqRuleSet, data: DqRuleSetUpdate
) -> DqRuleSet:
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(rule_set, key, value)
    await db.commit()
    await db.refresh(rule_set)
    return rule_set


async def delete(db: AsyncSession, rule_set: DqRuleSet) -> None:
    await db.delete(rule_set)  # cascades to checks via FK
    await db.commit()


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
