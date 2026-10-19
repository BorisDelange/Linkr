from types import SimpleNamespace

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
from app.models.dq_rule_set import DqCustomCheck, DqRuleSet, DqRunHistory
from app.models.user import User
from app.schemas.dq_rule_set import (
    DqChecksDelete,
    DqCustomCheckCreate,
    DqCustomCheckPatch,
    DqCustomCheckResponse,
    DqCustomCheckUpdate,
    DqRuleSetCreate,
    DqRuleSetResponse,
    DqRuleSetUpdate,
    DqRunHistoryCreate,
    DqRunHistoryResponse,
    DqRunHistoryUpdate,
)
from app.services import change_tracking, dq_rule_set_service, notification_service

router = APIRouter(tags=["data-quality"])

_SET = "/dq-rule-sets"
_CHECK = "/dq-custom-checks"
_RUN = "/dq-run-history"


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


# --- Notifications (writes by an external client, e.g. an agent over MCP) ---

# Cached outcome of the last run: the open tab refreshes, the bell stays quiet.
_SET_SIDE_FIELDS = {"status", "last_run_at", "last_run_duration_ms", "last_score"}
_CHECK_SIDE_FIELDS = {"order"}
_CHECK_FIELDS = (
    "name", "description", "category", "subcategory", "severity", "threshold", "sql",
    "explore_sql", "order", "table_name", "disabled",
)


def _check_state(check: DqCustomCheck) -> dict:
    return {k: getattr(check, k) for k in _CHECK_FIELDS}


def _changed_fields(before: dict, check: DqCustomCheck) -> set[str]:
    return {k for k, v in _check_state(check).items() if before.get(k) != v}


async def _notify(
    db: AsyncSession,
    request: Request,
    user: User,
    action: str,
    rule_set: DqRuleSet | SimpleNamespace,
    *,
    check: tuple[str, str] | None = None,
    count: int | None = None,
    notify: bool = True,
) -> None:
    """One change to a rule set or, with `check` = (action, name), to its checks
    (`count` of them for a batch). The workspace travels in `detail`: a rule set
    has no project."""
    detail: dict = {"workspaceId": rule_set.workspace_id}
    if check is not None:
        detail.update(part="check", action=check[0], name=check[1])
        if count is not None:
            detail["count"] = count
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request), action=action,
        entity_type="dq_rule_set", entity_id=rule_set.id, project_uid=None,
        label=rule_set.name, detail=detail, notify=notify,
    )


async def _notify_checks(
    db: AsyncSession, request: Request, user: User, rule_set: DqRuleSet, action: str,
    names: list[str], *, notify: bool = True,
) -> None:
    """A batch reads as one check when it holds one, else as a count."""
    if not names:
        return
    if len(names) == 1:
        await _notify(db, request, user, "updated", rule_set, check=(action, names[0]), notify=notify)
    else:
        await _notify(db, request, user, "updated", rule_set, check=(action, ""), count=len(names), notify=notify)


async def _notify_runs(
    db: AsyncSession, request: Request, user: User, rule_set_id: str | None, workspace_id: str | None,
) -> None:
    """A run is an execution, not an edit: refresh the open history, no notification."""
    if rule_set_id is None:
        return
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request), action="updated",
        entity_type="dq_run", entity_id=rule_set_id, project_uid=None, label=None,
        detail={"workspaceId": workspace_id}, notify=False,
    )


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
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, body.workspace_id, user, "data-quality:write")
    rule_set = await dq_rule_set_service.create(db, body)
    await _notify(db, request, user, "created", rule_set)
    return rule_set


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
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rule_set = await _load_rule_set(db, rule_set_id, user, "data-quality:write")
    before = change_tracking.changed_values(rule_set, body.model_dump(exclude_unset=True))
    rule_set = await dq_rule_set_service.update(db, rule_set, body)
    if before:
        await _notify(db, request, user, "updated", rule_set, notify=not before.keys() <= _SET_SIDE_FIELDS)
    return rule_set


@router.delete(_SET + "/{rule_set_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rule_set(
    rule_set_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rule_set = await _load_rule_set(db, rule_set_id, user, "data-quality:delete")
    gone = SimpleNamespace(id=rule_set.id, workspace_id=rule_set.workspace_id, name=rule_set.name)
    await dq_rule_set_service.delete(db, rule_set)
    await _notify(db, request, user, "deleted", gone)


# --- Custom checks ---------------------------------------------------------

@router.get(_SET + "/{rule_set_id}/checks", response_model=list[DqCustomCheckResponse])
async def list_checks(
    rule_set_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_rule_set(db, rule_set_id, user, "data-quality:read")
    return await dq_rule_set_service.list_checks(db, rule_set_id)


def _batch_error(exc: Exception) -> HTTPException:
    if isinstance(exc, dq_rule_set_service.ChecksTooMany):
        return HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, str(exc))
    if isinstance(exc, dq_rule_set_service.ChecksConflict):
        return HTTPException(status.HTTP_409_CONFLICT, str(exc))
    if isinstance(exc, dq_rule_set_service.ChecksNotFound):
        return HTTPException(status.HTTP_404_NOT_FOUND, str(exc))
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc))


def _require_own_checks(rule_set_id: str, body: list[DqCustomCheckCreate]) -> None:
    if any(c.rule_set_id != rule_set_id for c in body):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Every check must belong to the rule set")


@router.post(
    _SET + "/{rule_set_id}/checks",
    response_model=list[DqCustomCheckResponse],
    status_code=status.HTTP_201_CREATED,
)
async def create_checks(
    rule_set_id: str,
    body: list[DqCustomCheckCreate],
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """A rule set generated from a schema starts with hundreds of checks: one
    request, one transaction."""
    rule_set = await _load_rule_set(db, rule_set_id, user, "data-quality:write")
    _require_own_checks(rule_set_id, body)
    try:
        checks = await dq_rule_set_service.create_checks(db, body)
    except (dq_rule_set_service.ChecksTooMany, dq_rule_set_service.ChecksConflict) as exc:
        raise _batch_error(exc) from exc
    await _notify_checks(db, request, user, rule_set, "created", [c.name for c in checks])
    return checks


@router.put(_SET + "/{rule_set_id}/checks", response_model=list[DqCustomCheckResponse])
async def replace_checks(
    rule_set_id: str,
    body: list[DqCustomCheckCreate],
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The whole check list at once (an import): refused as a block, so the
    previous checks stay when the new ones do not validate."""
    rule_set = await _load_rule_set(db, rule_set_id, user, "data-quality:delete")
    _require_own_checks(rule_set_id, body)
    try:
        checks = await dq_rule_set_service.replace_checks(db, rule_set_id, body)
    except (dq_rule_set_service.ChecksTooMany, dq_rule_set_service.ChecksConflict) as exc:
        raise _batch_error(exc) from exc
    await _notify(db, request, user, "updated", rule_set, check=("replaced", ""), count=len(checks))
    return checks


@router.patch(_SET + "/{rule_set_id}/checks", response_model=list[DqCustomCheckResponse])
async def update_checks(
    rule_set_id: str,
    body: list[DqCustomCheckPatch],
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Several checks changed together (a group renamed, checks moved or
    disabled): all or none."""
    rule_set = await _load_rule_set(db, rule_set_id, user, "data-quality:write")
    targets = {p.id for p in body}
    before = {
        c.id: _check_state(c) for c in await dq_rule_set_service.list_checks(db, rule_set_id) if c.id in targets
    }
    try:
        checks = await dq_rule_set_service.update_checks(db, rule_set_id, body)
    except (ValueError, LookupError) as exc:
        raise _batch_error(exc) from exc
    changed = [(c.name, fields) for c in checks if (fields := _changed_fields(before.get(c.id, {}), c))]
    await _notify_checks(
        db, request, user, rule_set, "updated", [name for name, _ in changed],
        notify=not set().union(*(fields for _, fields in changed)) <= _CHECK_SIDE_FIELDS,
    )
    return checks


@router.post(_SET + "/{rule_set_id}/checks/batch-delete", status_code=status.HTTP_204_NO_CONTENT)
async def delete_checks(
    rule_set_id: str,
    body: DqChecksDelete,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rule_set = await _load_rule_set(db, rule_set_id, user, "data-quality:delete")
    ids = set(body.ids)
    names = [c.name for c in await dq_rule_set_service.list_checks(db, rule_set_id) if c.id in ids]
    try:
        await dq_rule_set_service.delete_checks(db, rule_set_id, body.ids)
    except dq_rule_set_service.ChecksTooMany as exc:
        raise _batch_error(exc) from exc
    await _notify_checks(db, request, user, rule_set, "deleted", names)


@router.delete(_SET + "/{rule_set_id}/checks", status_code=status.HTTP_204_NO_CONTENT)
async def delete_checks_for_rule_set(
    rule_set_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rule_set = await _load_rule_set(db, rule_set_id, user, "data-quality:delete")
    names = [c.name for c in await dq_rule_set_service.list_checks(db, rule_set_id)]
    await dq_rule_set_service.delete_checks_for_rule_set(db, rule_set_id)
    await _notify_checks(db, request, user, rule_set, "deleted", names)


@router.post(_CHECK, response_model=DqCustomCheckResponse, status_code=status.HTTP_201_CREATED)
async def create_check(
    body: DqCustomCheckCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rule_set = await _load_rule_set(db, body.rule_set_id, user, "data-quality:write")
    check = await dq_rule_set_service.create_check(db, body)
    await _notify(db, request, user, "updated", rule_set, check=("created", check.name))
    return check


@router.patch(_CHECK + "/{check_id}", response_model=DqCustomCheckResponse)
async def update_check(
    check_id: str,
    body: DqCustomCheckUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    check = await _load_check(db, check_id, user, "data-quality:write")
    before = _check_state(check)
    try:
        check = await dq_rule_set_service.update_check(db, check, body)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    changed = _changed_fields(before, check)
    if changed:
        rule_set = await dq_rule_set_service.get(db, check.rule_set_id)
        await _notify(
            db, request, user, "updated", rule_set, check=("updated", check.name),
            notify=not changed <= _CHECK_SIDE_FIELDS,
        )
    return check


@router.delete(_CHECK + "/{check_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_check(
    check_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    check = await _load_check(db, check_id, user, "data-quality:delete")
    rule_set_id, name = check.rule_set_id, check.name
    await dq_rule_set_service.delete_check(db, check)
    rule_set = await dq_rule_set_service.get(db, rule_set_id)
    await _notify(db, request, user, "updated", rule_set, check=("deleted", name))


# --- Run history -----------------------------------------------------------

async def _load_run(
    db: AsyncSession, run_id: str, user: User, permission: str
) -> DqRunHistory:
    run = await dq_rule_set_service.get_run(db, run_id)
    if run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if run.rule_set_id:
        await _load_rule_set(db, run.rule_set_id, user, permission)
    return run


@router.get(_SET + "/{rule_set_id}/runs", response_model=list[DqRunHistoryResponse])
async def list_runs(
    rule_set_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_rule_set(db, rule_set_id, user, "data-quality:read")
    return await dq_rule_set_service.list_runs(db, rule_set_id)


@router.delete(_SET + "/{rule_set_id}/runs", status_code=status.HTTP_204_NO_CONTENT)
async def delete_runs_for_rule_set(
    rule_set_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rule_set = await _load_rule_set(db, rule_set_id, user, "data-quality:write")
    await dq_rule_set_service.delete_runs_for_rule_set(db, rule_set_id)
    await _notify_runs(db, request, user, rule_set.id, rule_set.workspace_id)


@router.post(_RUN, response_model=DqRunHistoryResponse, status_code=status.HTTP_201_CREATED)
async def create_run(
    body: DqRunHistoryCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rule_set = await _load_rule_set(db, body.rule_set_id, user, "data-quality:write")
    # Trust the rule set's workspace, not the client-supplied one.
    body.workspace_id = rule_set.workspace_id
    run = await dq_rule_set_service.create_run(db, body)
    await _notify_runs(db, request, user, rule_set.id, rule_set.workspace_id)
    return run


@router.patch(_RUN + "/{run_id}", response_model=DqRunHistoryResponse)
async def update_run(
    run_id: str,
    body: DqRunHistoryUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    run = await _load_run(db, run_id, user, "data-quality:write")
    run = await dq_rule_set_service.update_run(db, run, body)
    await _notify_runs(db, request, user, run.rule_set_id, run.workspace_id)
    return run


@router.delete(_RUN + "/{run_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_run(
    run_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    run = await _load_run(db, run_id, user, "data-quality:write")
    rule_set_id, workspace_id = run.rule_set_id, run.workspace_id
    await dq_rule_set_service.delete_run(db, run)
    await _notify_runs(db, request, user, rule_set_id, workspace_id)
