from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
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
from app.services import change_tracking, notification_service, sql_script_service

router = APIRouter(tags=["sql-scripts"])

_COLL = "/sql-script-collections"
_FILE = "/sql-script-files"


async def _load_collection(
    db: AsyncSession, collection_id: str, user: User, permission: str
) -> SqlScriptCollection:
    collection = await sql_script_service.get(db, collection_id)
    if collection is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_permission(db, collection.workspace_id, user, permission)
    return collection


async def _load_file(
    db: AsyncSession, file_id: str, user: User, permission: str
) -> SqlScriptFile:
    node = await sql_script_service.get_file(db, file_id)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _load_collection(db, node.collection_id, user, permission)
    return node


# --- Notifications (writes by an external client, e.g. an agent over MCP) ---

# Fields a write sets as a side effect of something else (the versioning marks
# re-saved after a file write, the order a reorder rewrites one script at a
# time): the open tab refreshes, the bell stays quiet.
_COLLECTION_SIDE_FIELDS = {"config"}
_FILE_SIDE_FIELDS = {"order"}


async def _file_path(db: AsyncSession, node: SqlScriptFile) -> str:
    tree = await sql_script_service.list_tree(db, node.collection_id)
    return change_tracking.tree_path(node.id, node.name, node.parent_id, tree)


async def _notify(
    db: AsyncSession,
    request: Request,
    user: User,
    action: str,
    collection: SqlScriptCollection,
    *,
    file: tuple[str, str, str, str] | None = None,
    notify: bool = True,
) -> None:
    """One change to a collection or, with `file` = (action, path, type, id), to
    one of its files. The workspace travels in `detail`: the bell links there,
    and a collection has no project."""
    detail: dict = {"workspaceId": collection.workspace_id}
    if file is not None:
        detail.update(change_tracking.file_detail(*file))
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request), action=action,
        entity_type="sql_collection", entity_id=collection.id, project_uid=None,
        label=collection.name, detail=detail, notify=notify,
    )


# --- Collections -----------------------------------------------------------

@router.get(_COLL, response_model=list[SqlScriptCollectionResponse])
async def list_collections(
    workspace_id: str | None = Query(default=None, alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if workspace_id is not None:
        await check_workspace_permission(db, workspace_id, user, "sql-scripts:read")
        return await sql_script_service.list_for_workspace(db, workspace_id)
    # No filter: every collection the user can see (admin sees all; members see
    # the workspaces they belong to). Mirrors the data-sources listing.
    collections = await sql_script_service.list_all(db)
    visible: list[SqlScriptCollection] = []
    for c in collections:
        try:
            await check_workspace_permission(db, c.workspace_id, user, "sql-scripts:read")
            visible.append(c)
        except HTTPException:
            continue
    return visible


@router.post(_COLL, response_model=SqlScriptCollectionResponse, status_code=status.HTTP_201_CREATED)
async def create_collection(
    body: SqlScriptCollectionCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, body.workspace_id, user, "sql-scripts:write")
    collection = await sql_script_service.create(db, body)
    await _notify(db, request, user, "created", collection)
    return collection


@router.get(_COLL + "/{collection_id}", response_model=SqlScriptCollectionResponse)
async def get_collection(
    collection_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load_collection(db, collection_id, user, "sql-scripts:read")


@router.patch(_COLL + "/{collection_id}", response_model=SqlScriptCollectionResponse)
async def update_collection(
    collection_id: str,
    body: SqlScriptCollectionUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    collection = await _load_collection(db, collection_id, user, "sql-scripts:write")
    before = change_tracking.changed_values(collection, body.model_dump(exclude_unset=True))
    collection = await sql_script_service.update(db, collection, body)
    if before:
        await _notify(
            db, request, user, "updated", collection,
            notify=not before.keys() <= _COLLECTION_SIDE_FIELDS,
        )
    return collection


@router.delete(_COLL + "/{collection_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_collection(
    collection_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    collection = await _load_collection(db, collection_id, user, "sql-scripts:delete")
    await sql_script_service.delete(db, collection)
    await _notify(db, request, user, "deleted", collection)


# --- Files -----------------------------------------------------------------

@router.get(_COLL + "/{collection_id}/files", response_model=list[SqlScriptFileResponse])
async def list_files(
    collection_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_collection(db, collection_id, user, "sql-scripts:read")
    return await sql_script_service.list_files(db, collection_id)


@router.delete(_COLL + "/{collection_id}/files", status_code=status.HTTP_204_NO_CONTENT)
async def delete_files_for_collection(
    collection_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    collection = await _load_collection(db, collection_id, user, "sql-scripts:delete")
    await sql_script_service.delete_files_for_collection(db, collection_id)
    # Only ever the first half of deleting the collection, which is notified itself.
    await _notify(db, request, user, "updated", collection, notify=False)


@router.post(_FILE, response_model=SqlScriptFileResponse, status_code=status.HTTP_201_CREATED)
async def create_file(
    body: SqlScriptFileCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    collection = await _load_collection(db, body.collection_id, user, "sql-scripts:write")
    node = await sql_script_service.create_file(db, body)
    await _notify(
        db, request, user, "updated", collection,
        file=("created", await _file_path(db, node), node.type, node.id),
    )
    return node


@router.patch(_FILE + "/{file_id}", response_model=SqlScriptFileResponse)
async def update_file(
    file_id: str,
    body: SqlScriptFileUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    node = await _load_file(db, file_id, user, "sql-scripts:write")
    before = change_tracking.changed_values(node, body.model_dump(exclude_unset=True))
    node = await sql_script_service.update_file(db, node, body)
    if before:
        collection = await sql_script_service.get(db, node.collection_id)
        await _notify(
            db, request, user, "updated", collection,
            file=("updated", await _file_path(db, node), node.type, node.id),
            notify=not before.keys() <= _FILE_SIDE_FIELDS,
        )
    return node


@router.delete(_FILE + "/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_file(
    file_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    node = await _load_file(db, file_id, user, "sql-scripts:delete")
    collection = await sql_script_service.get(db, node.collection_id)
    path, kind = await _file_path(db, node), node.type
    await sql_script_service.delete_file(db, node)
    await _notify(db, request, user, "updated", collection, file=("deleted", path, kind, file_id))
