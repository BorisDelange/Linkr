from fastapi import APIRouter, Depends, HTTPException, Query, status
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
from app.services import wiki_page_service

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
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, body.workspace_id, user, "wiki:write")
    return await wiki_page_service.create(db, body)


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
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    page = await _get_page_with_role(page_id, user, db, "wiki:write")
    return await wiki_page_service.update(db, page, body)


@router.delete("/{page_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_wiki_page(
    page_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    page = await _get_page_with_role(page_id, user, db, "wiki:delete")
    await wiki_page_service.delete(db, page)
