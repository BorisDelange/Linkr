import json

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
from app.models.data_catalog import DataCatalog
from app.models.user import User
from app.schemas.data_catalog import (
    DataCatalogCreate,
    DataCatalogResponse,
    DataCatalogUpdate,
)
from app.schemas.stats_cache import StatsCacheResponse, StatsCacheSave
from app.services import change_tracking, data_catalog_service, notification_service, stats_cache_service

router = APIRouter(prefix="/data-catalogs", tags=["data-catalogs"])

_CATALOG_SCOPE = "catalog"

# --- Notifications (writes by an external client, e.g. an agent over MCP) ---

# What a compute writes back, and the versioning remote the git flow re-saves:
# the open page refreshes, the bell stays quiet.
_SIDE_FIELDS = {
    "counts", "status", "last_error", "last_computed_at", "last_compute_duration_ms", "computed_steps",
    "git_remote_config",
}


async def _notify(
    db: AsyncSession, request: Request, user: User, action: str, catalog: DataCatalog, *, notify: bool = True,
) -> None:
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request), action=action,
        entity_type="data_catalog", entity_id=catalog.id, project_uid=None, label=catalog.name,
        detail={"workspaceId": catalog.workspace_id}, notify=notify,
    )


async def _load(db: AsyncSession, catalog_id: str, user: User, permission: str) -> DataCatalog:
    catalog = await data_catalog_service.get(db, catalog_id)
    if catalog is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_permission(db, catalog.workspace_id, user, permission)
    return catalog


@router.get("", response_model=list[DataCatalogResponse])
async def list_catalogs(
    workspace_id: str | None = Query(default=None, alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if workspace_id is not None:
        await check_workspace_permission(db, workspace_id, user, "catalog:read")
        return await data_catalog_service.list_for_workspace(db, workspace_id)
    catalogs = await data_catalog_service.list_all(db)
    visible: list[DataCatalog] = []
    for c in catalogs:
        try:
            await check_workspace_permission(db, c.workspace_id, user, "catalog:read")
            visible.append(c)
        except HTTPException:
            continue
    return visible


@router.post("", response_model=DataCatalogResponse, status_code=status.HTTP_201_CREATED)
async def create_catalog(
    body: DataCatalogCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, body.workspace_id, user, "catalog:write")
    catalog = await data_catalog_service.create(db, body)
    await _notify(db, request, user, "created", catalog)
    return catalog


@router.get("/{catalog_id}", response_model=DataCatalogResponse)
async def get_catalog(
    catalog_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load(db, catalog_id, user, "catalog:read")


@router.patch("/{catalog_id}", response_model=DataCatalogResponse)
async def update_catalog(
    catalog_id: str,
    body: DataCatalogUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    catalog = await _load(db, catalog_id, user, "catalog:write")
    before = change_tracking.changed_values(catalog, body.model_dump(exclude_unset=True))
    catalog = await data_catalog_service.update(db, catalog, body)
    if before:
        await _notify(db, request, user, "updated", catalog, notify=not before.keys() <= _SIDE_FIELDS)
    return catalog


@router.delete("/{catalog_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_catalog(
    catalog_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    catalog = await _load(db, catalog_id, user, "catalog:delete")
    await data_catalog_service.delete(db, catalog)
    await _notify(db, request, user, "deleted", catalog)


@router.get("/{catalog_id}/results-cache", response_model=StatsCacheResponse | None)
async def get_catalog_results_cache(
    catalog_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Shared, precomputed catalog results (null if none). Stored server-side so
    every user of the workspace reuses one computed payload.

    The stored JSON goes out as it is, never through Python objects: the
    results can weigh tens of megabytes. Same shape as StatsCacheResponse.
    """
    await _load(db, catalog_id, user, "catalog:read")
    raw = await stats_cache_service.get_raw(db, _CATALOG_SCOPE, catalog_id)
    if raw is None:
        return Response(content="null", media_type="application/json")
    computed_at, payload = raw
    return Response(content=f'{{"computedAt":{json.dumps(computed_at)},"payload":{payload}}}', media_type="application/json")


@router.put("/{catalog_id}/results-cache", status_code=status.HTTP_204_NO_CONTENT)
async def save_catalog_results_cache(
    catalog_id: str,
    body: StatsCacheSave,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Store the catalog results a client just computed, sharing them. Nothing
    is sent back: echoing tens of megabytes on every save of a run is waste."""
    catalog = await _load(db, catalog_id, user, "catalog:write")
    await stats_cache_service.save(db, _CATALOG_SCOPE, catalog_id, body.computed_at, body.payload)
    await _notify(db, request, user, "updated", catalog, notify=False)


@router.delete("/{catalog_id}/results-cache", status_code=status.HTTP_204_NO_CONTENT)
async def delete_catalog_results_cache(
    catalog_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Reset the shared catalog results cache (the "reset" button)."""
    # Cache reset is a recompute, not deleting the catalog → write, not delete.
    catalog = await _load(db, catalog_id, user, "catalog:write")
    await stats_cache_service.delete(db, _CATALOG_SCOPE, catalog_id)
    await _notify(db, request, user, "updated", catalog, notify=False)
