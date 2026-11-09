"""Quality profiles. Their runs are written through /dq-run-history (dq_rule_sets.py)."""

from types import SimpleNamespace

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
from app.models.dq_rule_set import DqProfile
from app.models.user import User
from app.schemas.dq_rule_set import (
    DqProfileCreate,
    DqProfileResponse,
    DqProfileUpdate,
    DqRunHistoryResponse,
)
from app.services import change_tracking, database_binding, dq_profile_service, notification_service

router = APIRouter(tags=["data-quality"])

_PROFILE = "/dq-profiles"

# Cached outcome of the last run: the open tab refreshes, the bell stays quiet.
_SIDE_FIELDS = {"status", "last_run_at", "last_run_duration_ms", "last_score"}


async def load_profile(db: AsyncSession, profile_id: str, user: User, permission: str) -> DqProfile:
    profile = await dq_profile_service.get(db, profile_id)
    if profile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_permission(db, profile.workspace_id, user, permission)
    return profile


async def notify_profile(
    db: AsyncSession, request: Request, user: User, action: str,
    profile: DqProfile | SimpleNamespace, *, part: str | None = None, notify: bool = True,
) -> None:
    """One change to a profile, or with `part="run"` to its run history (an
    execution, not an edit: the open page refreshes, the bell stays quiet)."""
    detail: dict = {"workspaceId": profile.workspace_id}
    if part:
        detail["part"] = part
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request), action=action,
        entity_type="dq_profile", entity_id=profile.id, project_uid=None,
        label=profile.name, detail=detail, notify=notify,
    )


@router.get(_PROFILE, response_model=list[DqProfileResponse])
async def list_profiles(
    workspace_id: str | None = Query(default=None, alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if workspace_id is not None:
        await check_workspace_permission(db, workspace_id, user, "data-quality:read")
        return await dq_profile_service.list_for_workspace(db, workspace_id)
    visible: list[DqProfile] = []
    for profile in await dq_profile_service.list_all(db):
        try:
            await check_workspace_permission(db, profile.workspace_id, user, "data-quality:read")
            visible.append(profile)
        except HTTPException:
            continue
    return visible


@router.post(_PROFILE, response_model=DqProfileResponse, status_code=status.HTTP_201_CREATED)
async def create_profile(
    body: DqProfileCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, body.workspace_id, user, "data-quality:write")
    await database_binding.require_bindable(db, body.workspace_id, user, [body.data_source_id])
    if await dq_profile_service.get(db, body.id) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This profile id is already in use")
    profile = await dq_profile_service.create(db, body)
    await notify_profile(db, request, user, "created", profile)
    return profile


@router.get(_PROFILE + "/{profile_id}", response_model=DqProfileResponse)
async def get_profile(
    profile_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await load_profile(db, profile_id, user, "data-quality:read")


@router.patch(_PROFILE + "/{profile_id}", response_model=DqProfileResponse)
async def update_profile(
    profile_id: str,
    body: DqProfileUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    profile = await load_profile(db, profile_id, user, "data-quality:write")
    await database_binding.require_bindable(
        db, profile.workspace_id, user, database_binding.changed_ids(profile, body, "data_source_id")
    )
    if body.last_score is not None:
        await database_binding.require_stored_local(db, profile.workspace_id, profile.data_source_id)
    before = change_tracking.changed_values(profile, body.model_dump(exclude_unset=True))
    profile = await dq_profile_service.update(db, profile, body)
    if before:
        await notify_profile(db, request, user, "updated", profile, notify=not before.keys() <= _SIDE_FIELDS)
    return profile


@router.delete(_PROFILE + "/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_profile(
    profile_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    profile = await load_profile(db, profile_id, user, "data-quality:delete")
    gone = SimpleNamespace(id=profile.id, workspace_id=profile.workspace_id, name=profile.name)
    await dq_profile_service.delete(db, profile)
    await notify_profile(db, request, user, "deleted", gone)


@router.get(_PROFILE + "/{profile_id}/runs", response_model=list[DqRunHistoryResponse])
async def list_runs(
    profile_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    profile = await load_profile(db, profile_id, user, "data-quality:read")
    # Results come from the database: reading them asks the right to read it.
    await check_workspace_permission(db, profile.workspace_id, user, "databases:read")
    return await dq_profile_service.list_runs(db, profile_id)


@router.delete(_PROFILE + "/{profile_id}/runs", status_code=status.HTTP_204_NO_CONTENT)
async def delete_runs(
    profile_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    profile = await load_profile(db, profile_id, user, "data-quality:write")
    await dq_profile_service.delete_runs(db, profile_id)
    await notify_profile(db, request, user, "updated", profile, part="run", notify=False)
