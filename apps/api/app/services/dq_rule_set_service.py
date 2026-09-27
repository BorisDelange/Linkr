from collections import Counter

from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dq_rule_set import DqCustomCheck, DqRuleSet, DqRunHistory
from app.services import attachment_service, git_secret
from app.schemas.dq_rule_set import (
    DqCustomCheckCreate,
    DqCustomCheckPatch,
    DqCustomCheckUpdate,
    DqRuleSetCreate,
    DqRuleSetUpdate,
    DqRunHistoryCreate,
    DqRunHistoryUpdate,
)
from app.schemas.dq_taxonomy import fitting_subcategory, normalize_category


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
    from app.services import git_service

    rule_set_id = rule_set.id
    await db.delete(rule_set)  # cascades to checks via FK
    await db.commit()
    # The README attachments' owner is polymorphic (no FK), so clean them here.
    await attachment_service.delete_readme_for_owner(db, "dq-rule-set", rule_set_id)
    # Remove the on-disk versioning working tree so it doesn't linger as an orphan.
    git_service.remove_repo("dq-rule-sets", rule_set_id)


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


MAX_CHECKS_PER_REQUEST = 5000


class ChecksConflict(ValueError):
    """A check id sent twice, or already taken by another check."""


class ChecksTooMany(ValueError):
    pass


class ChecksNotFound(LookupError):
    pass


async def _validate_new_checks(
    db: AsyncSession, data: list[DqCustomCheckCreate], replacing: str | None = None
) -> None:
    """Raises before anything is written, so a refused batch leaves the rule set
    as it was. `replacing`: the rule set whose own checks are about to go, so
    their ids may be reused."""
    if len(data) > MAX_CHECKS_PER_REQUEST:
        raise ChecksTooMany(f"At most {MAX_CHECKS_PER_REQUEST} checks per request")
    ids = [d.id for d in data]
    duplicates = sorted(i for i, n in Counter(ids).items() if n > 1)
    if duplicates:
        raise ChecksConflict(f"Duplicate check ids: {', '.join(duplicates[:10])}")
    if not ids:
        return
    query = select(DqCustomCheck.id).where(DqCustomCheck.id.in_(ids))
    if replacing is not None:
        query = query.where(DqCustomCheck.rule_set_id != replacing)
    taken = sorted((await db.execute(query)).scalars().all())
    if taken:
        raise ChecksConflict(f"Check ids already in use: {', '.join(taken[:10])}")


async def _commit_new_checks(db: AsyncSession) -> None:
    # A concurrent write can still take an id between the check and the commit.
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise ChecksConflict("A check id is already in use") from exc


async def _checks_by_ids(db: AsyncSession, ids: list[str]) -> list[DqCustomCheck]:
    result = await db.execute(
        select(DqCustomCheck)
        .where(DqCustomCheck.id.in_(ids))
        .order_by(DqCustomCheck.order)
    )
    return list(result.scalars().all())


async def create_checks(
    db: AsyncSession, data: list[DqCustomCheckCreate]
) -> list[DqCustomCheck]:
    """Raises ChecksConflict / ChecksTooMany before writing anything."""
    await _validate_new_checks(db, data)
    checks = [DqCustomCheck(**d.model_dump(exclude_none=True)) for d in data]
    db.add_all(checks)
    await _commit_new_checks(db)
    return await _checks_by_ids(db, [c.id for c in checks])


async def replace_checks(
    db: AsyncSession, rule_set_id: str, data: list[DqCustomCheckCreate]
) -> list[DqCustomCheck]:
    """A rule set's whole check list in one transaction: an import that the
    server refuses leaves the previous checks in place."""
    await _validate_new_checks(db, data, replacing=rule_set_id)
    await db.execute(sa_delete(DqCustomCheck).where(DqCustomCheck.rule_set_id == rule_set_id))
    checks = [DqCustomCheck(**d.model_dump(exclude_none=True)) for d in data]
    db.add_all(checks)
    await _commit_new_checks(db)
    return await _checks_by_ids(db, [c.id for c in checks])


def _apply_check_update(check: DqCustomCheck, data: DqCustomCheckUpdate) -> None:
    """Raises ValueError when the category and subcategory do not fit together."""
    changes = data.model_dump(exclude_unset=True, exclude={"id"})
    if "category" in changes or "subcategory" in changes:
        category = changes.get("category", check.category)
        if "subcategory" in changes:
            category, subcategory = normalize_category(category, changes["subcategory"])
        else:
            category, subcategory = normalize_category(category, None)
            if category == changes.get("category", check.category):
                subcategory = fitting_subcategory(category, check.subcategory)
        changes["category"], changes["subcategory"] = category, subcategory
    for key, value in changes.items():
        setattr(check, key, value)


async def update_check(
    db: AsyncSession, check: DqCustomCheck, data: DqCustomCheckUpdate
) -> DqCustomCheck:
    """Raises ValueError when the category and subcategory do not fit together."""
    _apply_check_update(check, data)
    await db.commit()
    await db.refresh(check)
    return check


async def update_checks(
    db: AsyncSession, rule_set_id: str, patches: list[DqCustomCheckPatch]
) -> list[DqCustomCheck]:
    """Several checks' changes in one transaction: all of them, or none.
    Raises ChecksNotFound for an id outside the rule set, ValueError for a change
    that does not fit the taxonomy, ChecksTooMany for an oversized batch."""
    if len(patches) > MAX_CHECKS_PER_REQUEST:
        raise ChecksTooMany(f"At most {MAX_CHECKS_PER_REQUEST} checks per request")
    ids = [p.id for p in patches]
    result = await db.execute(
        select(DqCustomCheck).where(
            DqCustomCheck.rule_set_id == rule_set_id, DqCustomCheck.id.in_(ids)
        )
    )
    by_id = {c.id: c for c in result.scalars().all()}
    missing = sorted(set(ids) - by_id.keys())
    if missing:
        raise ChecksNotFound(f"No such check in this rule set: {', '.join(missing[:10])}")
    try:
        for patch in patches:
            _apply_check_update(by_id[patch.id], patch)
    except ValueError:
        await db.rollback()
        raise
    await db.commit()
    return await _checks_by_ids(db, list(by_id))


async def delete_check(db: AsyncSession, check: DqCustomCheck) -> None:
    await db.delete(check)
    await db.commit()


async def delete_checks(db: AsyncSession, rule_set_id: str, ids: list[str]) -> None:
    """Idempotent: an id already gone, or of another rule set, is left alone."""
    if len(ids) > MAX_CHECKS_PER_REQUEST:
        raise ChecksTooMany(f"At most {MAX_CHECKS_PER_REQUEST} checks per request")
    await db.execute(
        sa_delete(DqCustomCheck).where(
            DqCustomCheck.rule_set_id == rule_set_id, DqCustomCheck.id.in_(ids)
        )
    )
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
