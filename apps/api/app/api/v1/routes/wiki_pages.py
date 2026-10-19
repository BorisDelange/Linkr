from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
from app.models.user import User
from app.models.wiki_page import WikiPage
from app.schemas.wiki_page import (
    WikiPageCreate,
    WikiPageResponse,
    WikiPageSearchResult,
    WikiPageUpdate,
)
from app.services import change_tracking, notification_service, wiki_page_service

router = APIRouter(prefix="/wiki-pages", tags=["wiki-pages"])


async def _get_page_with_role(
    page_id: str, user: User, db: AsyncSession, permission: str
) -> WikiPage:
    page = await wiki_page_service.get(db, page_id)
    if page is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if page.workspace_id is not None:
        await check_workspace_permission(db, page.workspace_id, user, permission)
    return page


# Rewritten for every sibling when the user drags a page: refresh, no notification.
_SIDE_FIELDS = {"sort_order"}


async def _notify(
    db: AsyncSession, request: Request, user: User, action: str, page: WikiPage, *, notify: bool = True
) -> None:
    """A change to a wiki page. Pages belong to a workspace, not a project: the
    workspace travels in `detail` for the bell to link there."""
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request), action=action,
        entity_type="wiki_page", entity_id=page.id, project_uid=None,
        label=page.title, detail={"workspaceId": page.workspace_id}, notify=notify,
    )


@router.get("", response_model=list[WikiPageResponse])
async def list_wiki_pages(
    workspace_id: str = Query(alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, workspace_id, user, "wiki:read")
    return await wiki_page_service.list_for_workspace(db, workspace_id)


@router.get("/search", response_model=list[WikiPageSearchResult])
async def search_wiki_pages(
    workspace_id: str = Query(alias="workspaceId"),
    q: str = Query(default=""),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, workspace_id, user, "wiki:read")
    return await wiki_page_service.search_for_workspace(db, workspace_id, q)


@router.post("", response_model=WikiPageResponse, status_code=status.HTTP_201_CREATED)
async def create_wiki_page(
    body: WikiPageCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, body.workspace_id, user, "wiki:write")
    page = await wiki_page_service.create(db, body)
    await _notify(db, request, user, "created", page)
    return page


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def delete_wiki_pages_by_workspace(
    workspace_id: str = Query(alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, workspace_id, user, "wiki:delete")
    await wiki_page_service.delete_for_workspace(db, workspace_id)


@router.get("/{page_id}", response_model=WikiPageResponse)
async def get_wiki_page(
    page_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _get_page_with_role(page_id, user, db, "wiki:read")


@router.patch("/{page_id}", response_model=WikiPageResponse)
async def update_wiki_page(
    page_id: str,
    body: WikiPageUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    page = await _get_page_with_role(page_id, user, db, "wiki:write")
    before = change_tracking.changed_values(page, body.model_dump(exclude_unset=True))
    page = await wiki_page_service.update(db, page, body)
    if before:
        await _notify(db, request, user, "updated", page, notify=not before.keys() <= _SIDE_FIELDS)
    return page


@router.delete("/{page_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_wiki_page(
    page_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    page = await _get_page_with_role(page_id, user, db, "wiki:delete")
    await wiki_page_service.delete(db, page)
    await _notify(db, request, user, "deleted", page)
