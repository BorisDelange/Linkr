from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_role
from app.models.sql_script import SqlScriptCollection, SqlScriptFile
from app.models.user import User
from app.schemas.sql_script import (
    SqlScriptCollectionCreate,
    SqlScriptCollectionResponse,
    SqlScriptCollectionUpdate,
    SqlScriptFileCreate,
    SqlScriptFileResponse,
    SqlScriptFileUpdate,
)
from app.services import sql_script_service

router = APIRouter(tags=["sql-scripts"])

_COLL = "/sql-script-collections"
_FILE = "/sql-script-files"


async def _load_collection(
    db: AsyncSession, collection_id: str, user: User, min_role: str
) -> SqlScriptCollection:
    collection = await sql_script_service.get(db, collection_id)
    if collection is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_role(db, collection.workspace_id, user, min_role)
    return collection


async def _load_file(
    db: AsyncSession, file_id: str, user: User, min_role: str
) -> SqlScriptFile:
    node = await sql_script_service.get_file(db, file_id)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _load_collection(db, node.collection_id, user, min_role)
    return node


# --- Collections -----------------------------------------------------------

@router.get(_COLL, response_model=list[SqlScriptCollectionResponse])
async def list_collections(
    workspace_id: str | None = Query(default=None, alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if workspace_id is not None:
        await check_workspace_role(db, workspace_id, user, "viewer")
        return await sql_script_service.list_for_workspace(db, workspace_id)
    # No filter: every collection the user can see (admin sees all; members see
    # the workspaces they belong to). Mirrors the data-sources listing.
    collections = await sql_script_service.list_all(db)
    visible: list[SqlScriptCollection] = []
    for c in collections:
        try:
            await check_workspace_role(db, c.workspace_id, user, "viewer")
            visible.append(c)
        except HTTPException:
            continue
    return visible


@router.post(_COLL, response_model=SqlScriptCollectionResponse, status_code=status.HTTP_201_CREATED)
async def create_collection(
    body: SqlScriptCollectionCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_role(db, body.workspace_id, user, "editor")
    return await sql_script_service.create(db, body)


@router.get(_COLL + "/{collection_id}", response_model=SqlScriptCollectionResponse)
async def get_collection(
    collection_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load_collection(db, collection_id, user, "viewer")


@router.patch(_COLL + "/{collection_id}", response_model=SqlScriptCollectionResponse)
async def update_collection(
    collection_id: str,
    body: SqlScriptCollectionUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    collection = await _load_collection(db, collection_id, user, "editor")
    return await sql_script_service.update(db, collection, body)


@router.delete(_COLL + "/{collection_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_collection(
    collection_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    collection = await _load_collection(db, collection_id, user, "editor")
    await sql_script_service.delete(db, collection)


# --- Files -----------------------------------------------------------------

@router.get(_COLL + "/{collection_id}/files", response_model=list[SqlScriptFileResponse])
async def list_files(
    collection_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_collection(db, collection_id, user, "viewer")
    return await sql_script_service.list_files(db, collection_id)


@router.delete(_COLL + "/{collection_id}/files", status_code=status.HTTP_204_NO_CONTENT)
async def delete_files_for_collection(
    collection_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_collection(db, collection_id, user, "editor")
    await sql_script_service.delete_files_for_collection(db, collection_id)


@router.post(_FILE, response_model=SqlScriptFileResponse, status_code=status.HTTP_201_CREATED)
async def create_file(
    body: SqlScriptFileCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_collection(db, body.collection_id, user, "editor")
    return await sql_script_service.create_file(db, body)


@router.patch(_FILE + "/{file_id}", response_model=SqlScriptFileResponse)
async def update_file(
    file_id: str,
    body: SqlScriptFileUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    node = await _load_file(db, file_id, user, "editor")
    return await sql_script_service.update_file(db, node, body)


@router.delete(_FILE + "/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_file(
    file_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    node = await _load_file(db, file_id, user, "editor")
    await sql_script_service.delete_file(db, node)
