from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
from app.models.user import User
from app.schemas.source_concept_id import (
    SourceConceptIdEntryBatch,
    SourceConceptIdEntryResponse,
    SourceConceptIdEntrySave,
    SourceConceptIdRangeResponse,
    SourceConceptIdRangeSave,
)
from app.services import source_concept_id_service as svc

router = APIRouter(tags=["source-concept-ids"])

_RANGES = "/source-concept-id-ranges"
_ENTRIES = "/source-concept-id-entries"


# --- Ranges ----------------------------------------------------------------

@router.get(_RANGES, response_model=list[SourceConceptIdRangeResponse])
async def list_ranges(
    workspace_id: str = Query(alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, workspace_id, user, "concept-mapping:read")
    return await svc.list_ranges(db, workspace_id)


@router.get(_RANGES + "/{workspace_id}/{badge_label}", response_model=SourceConceptIdRangeResponse)
async def get_range(
    workspace_id: str,
    badge_label: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, workspace_id, user, "concept-mapping:read")
    rng = await svc.get_range(db, workspace_id, badge_label)
    if rng is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return rng


@router.put(_RANGES, response_model=SourceConceptIdRangeResponse)
async def save_range(
    body: SourceConceptIdRangeSave,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, body.workspace_id, user, "concept-mapping:write")
    return await svc.save_range(db, body)


@router.delete(_RANGES + "/{workspace_id}/{badge_label}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_range(
    workspace_id: str,
    badge_label: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, workspace_id, user, "concept-mapping:delete")
    await svc.delete_range(db, workspace_id, badge_label)


@router.delete(_RANGES, status_code=status.HTTP_204_NO_CONTENT)
async def delete_ranges_for_workspace(
    workspace_id: str = Query(alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, workspace_id, user, "concept-mapping:delete")
    await svc.delete_ranges_for_workspace(db, workspace_id)


# --- Entries ---------------------------------------------------------------

@router.get(_ENTRIES + "/counts")
async def entry_counts(
    workspace_id: str = Query(alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Per-badge assigned/own counts (integers only) — lets the Source IDs tab
    show counts without downloading every entry."""
    await check_workspace_permission(db, workspace_id, user, "concept-mapping:read")
    return await svc.count_entries_by_badge(db, workspace_id)


@router.get(_ENTRIES, response_model=list[SourceConceptIdEntryResponse])
async def list_entries(
    workspace_id: str = Query(alias="workspaceId"),
    badge_label: str | None = Query(default=None, alias="badgeLabel"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, workspace_id, user, "concept-mapping:read")
    if badge_label is not None:
        return await svc.list_entries_for_badge(db, workspace_id, badge_label)
    return await svc.list_entries(db, workspace_id)


@router.put(_ENTRIES, response_model=SourceConceptIdEntryResponse)
async def save_entry(
    body: SourceConceptIdEntrySave,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, body.workspace_id, user, "concept-mapping:write")
    await svc.save_entry(db, body)
    return body


@router.put(_ENTRIES + "/batch", status_code=status.HTTP_204_NO_CONTENT)
async def save_entries_batch(
    body: SourceConceptIdEntryBatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # All entries must target the same accessible workspace(s); authorize each.
    for ws in {e.workspace_id for e in body.entries}:
        await check_workspace_permission(db, ws, user, "concept-mapping:write")
    await svc.save_entries(db, body.entries)


@router.delete(_ENTRIES, status_code=status.HTTP_204_NO_CONTENT)
async def delete_entries(
    workspace_id: str = Query(alias="workspaceId"),
    badge_label: str | None = Query(default=None, alias="badgeLabel"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, workspace_id, user, "concept-mapping:delete")
    if badge_label is not None:
        await svc.delete_entries_for_badge(db, workspace_id, badge_label)
    else:
        await svc.delete_entries_for_workspace(db, workspace_id)
