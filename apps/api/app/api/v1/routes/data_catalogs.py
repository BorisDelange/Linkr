from fastapi import APIRouter, Depends, HTTPException, Query, status
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
from app.services import data_catalog_service, stats_cache_service

router = APIRouter(prefix="/data-catalogs", tags=["data-catalogs"])

_CATALOG_SCOPE = "catalog"


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
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, body.workspace_id, user, "catalog:write")
    return await data_catalog_service.create(db, body)


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
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    catalog = await _load(db, catalog_id, user, "catalog:write")
    return await data_catalog_service.update(db, catalog, body)


@router.delete("/{catalog_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_catalog(
    catalog_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    catalog = await _load(db, catalog_id, user, "catalog:delete")
    await data_catalog_service.delete(db, catalog)


@router.get("/{catalog_id}/results-cache", response_model=StatsCacheResponse | None)
async def get_catalog_results_cache(
    catalog_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Shared, precomputed catalog results (null if none). Stored server-side so
    every user of the workspace reuses one computed payload."""
    await _load(db, catalog_id, user, "catalog:read")
    row = await stats_cache_service.get(db, _CATALOG_SCOPE, catalog_id)
    if row is None:
        return None
    return StatsCacheResponse(computed_at=row.computed_at, payload=row.payload)


@router.put("/{catalog_id}/results-cache", response_model=StatsCacheResponse)
async def save_catalog_results_cache(
    catalog_id: str,
    body: StatsCacheSave,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Store the catalog results a client just computed, sharing them."""
    await _load(db, catalog_id, user, "catalog:write")
    row = await stats_cache_service.save(
        db, _CATALOG_SCOPE, catalog_id, body.computed_at, body.payload
    )
    return StatsCacheResponse(computed_at=row.computed_at, payload=row.payload)


@router.delete("/{catalog_id}/results-cache", status_code=status.HTTP_204_NO_CONTENT)
async def delete_catalog_results_cache(
    catalog_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Reset the shared catalog results cache (the "reset" button)."""
    # Cache reset is a recompute, not deleting the catalog → write, not delete.
    await _load(db, catalog_id, user, "catalog:write")
    await stats_cache_service.delete(db, _CATALOG_SCOPE, catalog_id)
