from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
from app.models.dq_rule_set import DqCustomCheck, DqRuleSet
from app.models.user import User
from app.schemas.dq_rule_set import (
    DqCustomCheckCreate,
    DqCustomCheckResponse,
    DqCustomCheckUpdate,
    DqRuleSetCreate,
    DqRuleSetResponse,
    DqRuleSetUpdate,
)
from app.services import dq_rule_set_service

router = APIRouter(tags=["data-quality"])

_SET = "/dq-rule-sets"
_CHECK = "/dq-custom-checks"


async def _load_rule_set(
    db: AsyncSession, rule_set_id: str, user: User, permission: str
) -> DqRuleSet:
    rule_set = await dq_rule_set_service.get(db, rule_set_id)
    if rule_set is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_permission(db, rule_set.workspace_id, user, permission)
    return rule_set


async def _load_check(
    db: AsyncSession, check_id: str, user: User, permission: str
) -> DqCustomCheck:
    check = await dq_rule_set_service.get_check(db, check_id)
    if check is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _load_rule_set(db, check.rule_set_id, user, permission)
    return check


# --- Rule sets -------------------------------------------------------------

@router.get(_SET, response_model=list[DqRuleSetResponse])
async def list_rule_sets(
    workspace_id: str | None = Query(default=None, alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if workspace_id is not None:
        await check_workspace_permission(db, workspace_id, user, "data-quality:read")
        return await dq_rule_set_service.list_for_workspace(db, workspace_id)
    rule_sets = await dq_rule_set_service.list_all(db)
    visible: list[DqRuleSet] = []
    for rs in rule_sets:
        try:
            await check_workspace_permission(db, rs.workspace_id, user, "data-quality:read")
            visible.append(rs)
        except HTTPException:
            continue
    return visible


@router.post(_SET, response_model=DqRuleSetResponse, status_code=status.HTTP_201_CREATED)
async def create_rule_set(
    body: DqRuleSetCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, body.workspace_id, user, "data-quality:write")
    return await dq_rule_set_service.create(db, body)


@router.get(_SET + "/{rule_set_id}", response_model=DqRuleSetResponse)
async def get_rule_set(
    rule_set_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load_rule_set(db, rule_set_id, user, "data-quality:read")


@router.patch(_SET + "/{rule_set_id}", response_model=DqRuleSetResponse)
async def update_rule_set(
    rule_set_id: str,
    body: DqRuleSetUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rule_set = await _load_rule_set(db, rule_set_id, user, "data-quality:write")
    return await dq_rule_set_service.update(db, rule_set, body)


@router.delete(_SET + "/{rule_set_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rule_set(
    rule_set_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rule_set = await _load_rule_set(db, rule_set_id, user, "data-quality:delete")
    await dq_rule_set_service.delete(db, rule_set)


# --- Custom checks ---------------------------------------------------------

@router.get(_SET + "/{rule_set_id}/checks", response_model=list[DqCustomCheckResponse])
async def list_checks(
    rule_set_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_rule_set(db, rule_set_id, user, "data-quality:read")
    return await dq_rule_set_service.list_checks(db, rule_set_id)


@router.delete(_SET + "/{rule_set_id}/checks", status_code=status.HTTP_204_NO_CONTENT)
async def delete_checks_for_rule_set(
    rule_set_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_rule_set(db, rule_set_id, user, "data-quality:delete")
    await dq_rule_set_service.delete_checks_for_rule_set(db, rule_set_id)


@router.post(_CHECK, response_model=DqCustomCheckResponse, status_code=status.HTTP_201_CREATED)
async def create_check(
    body: DqCustomCheckCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_rule_set(db, body.rule_set_id, user, "data-quality:write")
    return await dq_rule_set_service.create_check(db, body)


@router.patch(_CHECK + "/{check_id}", response_model=DqCustomCheckResponse)
async def update_check(
    check_id: str,
    body: DqCustomCheckUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    check = await _load_check(db, check_id, user, "data-quality:write")
    return await dq_rule_set_service.update_check(db, check, body)


@router.delete(_CHECK + "/{check_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_check(
    check_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    check = await _load_check(db, check_id, user, "data-quality:delete")
    await dq_rule_set_service.delete_check(db, check)
