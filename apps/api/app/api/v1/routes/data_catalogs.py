from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_role
from app.models.data_catalog import DataCatalog
from app.models.user import User
from app.schemas.data_catalog import (
    DataCatalogCreate,
    DataCatalogResponse,
    DataCatalogUpdate,
)
from app.services import data_catalog_service

router = APIRouter(prefix="/data-catalogs", tags=["data-catalogs"])


async def _load(db: AsyncSession, catalog_id: str, user: User, min_role: str) -> DataCatalog:
    catalog = await data_catalog_service.get(db, catalog_id)
    if catalog is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_role(db, catalog.workspace_id, user, min_role)
    return catalog


@router.get("", response_model=list[DataCatalogResponse])
async def list_catalogs(
    workspace_id: str | None = Query(default=None, alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if workspace_id is not None:
        await check_workspace_role(db, workspace_id, user, "viewer")
        return await data_catalog_service.list_for_workspace(db, workspace_id)
    catalogs = await data_catalog_service.list_all(db)
    visible: list[DataCatalog] = []
    for c in catalogs:
        try:
            await check_workspace_role(db, c.workspace_id, user, "viewer")
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
    await check_workspace_role(db, body.workspace_id, user, "editor")
    return await data_catalog_service.create(db, body)


@router.get("/{catalog_id}", response_model=DataCatalogResponse)
async def get_catalog(
    catalog_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load(db, catalog_id, user, "viewer")


@router.patch("/{catalog_id}", response_model=DataCatalogResponse)
async def update_catalog(
    catalog_id: str,
    body: DataCatalogUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    catalog = await _load(db, catalog_id, user, "editor")
    return await data_catalog_service.update(db, catalog, body)


@router.delete("/{catalog_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_catalog(
    catalog_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    catalog = await _load(db, catalog_id, user, "editor")
    await data_catalog_service.delete(db, catalog)
