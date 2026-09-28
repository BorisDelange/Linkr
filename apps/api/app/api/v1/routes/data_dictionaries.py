"""A workspace's data dictionaries (concept sets + units). The client reads the
repository and sends its content; the server applies the sync."""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
from app.models.data_dictionary import DataDictionary
from app.models.user import User
from app.schemas.data_dictionary import (
    DataDictionaryCreate,
    DataDictionaryResponse,
    DataDictionarySync,
    DataDictionarySyncResult,
    DataDictionaryUpdate,
)
from app.services import data_dictionary_service as svc

router = APIRouter(prefix="/data-dictionaries", tags=["data-dictionaries"])


async def _load(db: AsyncSession, dictionary_id: str, user: User, permission: str) -> DataDictionary:
    d = await svc.get(db, dictionary_id)
    if d is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_permission(db, d.workspace_id, user, permission)
    return d


@router.get("", response_model=list[DataDictionaryResponse])
async def list_dictionaries(
    workspace_id: str = Query(..., alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, workspace_id, user, "concept-mapping:read")
    return await svc.list_for_workspace(db, workspace_id)


@router.post("", response_model=DataDictionaryResponse, status_code=status.HTTP_201_CREATED)
async def create_dictionary(
    body: DataDictionaryCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, body.workspace_id, user, "workspace-settings:write")
    return await svc.create(db, body)


@router.patch("/{dictionary_id}", response_model=DataDictionaryResponse)
async def update_dictionary(
    dictionary_id: str,
    body: DataDictionaryUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    d = await _load(db, dictionary_id, user, "workspace-settings:write")
    return await svc.update(db, d, body)


@router.put("/{dictionary_id}/content", response_model=DataDictionarySyncResult)
async def sync_dictionary(
    dictionary_id: str,
    body: DataDictionarySync,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Replace the dictionary's content with the repository's (see svc.sync)."""
    d = await _load(db, dictionary_id, user, "workspace-settings:write")
    return await svc.sync(db, d, body)


@router.delete("/{dictionary_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dictionary(
    dictionary_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete the dictionary with its concept sets."""
    d = await _load(db, dictionary_id, user, "workspace-settings:write")
    await svc.delete(db, d)
