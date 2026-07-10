from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_project_role, check_workspace_role
from app.models.project import Project
from app.models.user import User
from app.schemas.attachment import ReadmeAttachmentResponse, WikiAttachmentResponse
from app.services import attachment_service, blob_store


async def _require_project(db: AsyncSession, project_uid: str, user: User, min_role: str) -> None:
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    await check_project_role(db, project, user, min_role)


async def _require_readme_scope(
    db: AsyncSession, *, project_uid: str | None, workspace_id: str | None,
    user: User, min_role: str,
) -> None:
    """A README attachment is scoped to a project or a workspace; enforce the
    matching role."""
    if project_uid is not None:
        await _require_project(db, project_uid, user, min_role)
    elif workspace_id is not None:
        await check_workspace_role(db, workspace_id, user, min_role)
    else:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "projectUid or workspaceId required")


# --- README attachments (project- OR workspace-scoped) ----------------------

readme_router = APIRouter(prefix="/readme-attachments", tags=["attachments"])


@readme_router.get("", response_model=list[ReadmeAttachmentResponse])
async def list_readme(
    project_uid: str | None = Query(alias="projectUid", default=None),
    workspace_id: str | None = Query(alias="workspaceId", default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_readme_scope(db, project_uid=project_uid, workspace_id=workspace_id, user=user, min_role="viewer")
    if project_uid is not None:
        return await attachment_service.list_readme(db, project_uid)
    return await attachment_service.list_readme_by_workspace(db, workspace_id)


@readme_router.post("", response_model=ReadmeAttachmentResponse, status_code=status.HTTP_201_CREATED)
async def create_readme(
    request: Request,
    id: str = Query(),
    file_name: str = Query(alias="fileName"),
    project_uid: str | None = Query(alias="projectUid", default=None),
    workspace_id: str | None = Query(alias="workspaceId", default=None),
    mime_type: str = Query(alias="mimeType", default=""),
    created_at: str | None = Query(alias="createdAt", default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_readme_scope(db, project_uid=project_uid, workspace_id=workspace_id, user=user, min_role="editor")
    data = await request.body()
    return await attachment_service.create_readme(
        db, id=id, project_uid=project_uid, workspace_id=workspace_id, file_name=file_name,
        mime_type=mime_type, created_at=created_at, data=data,
    )


@readme_router.get("/{att_id}/blob")
async def get_readme_blob(
    att_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    att = await attachment_service.get_readme(db, att_id)
    if att is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _require_readme_scope(db, project_uid=att.project_uid, workspace_id=att.workspace_id, user=user, min_role="viewer")
    data = await blob_store.read_bytes(att.blob_sha)
    return Response(content=data, media_type=att.mime_type or "application/octet-stream",
                    headers={"x-file-name": att.file_name})


@readme_router.delete("/{att_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_readme(
    att_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    att = await attachment_service.get_readme(db, att_id)
    if att is None:
        return
    await _require_readme_scope(db, project_uid=att.project_uid, workspace_id=att.workspace_id, user=user, min_role="editor")
    await attachment_service.delete_readme(db, att)


@readme_router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def delete_readme_batch(
    project_uid: str | None = Query(alias="projectUid", default=None),
    workspace_id: str | None = Query(alias="workspaceId", default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_readme_scope(db, project_uid=project_uid, workspace_id=workspace_id, user=user, min_role="editor")
    if project_uid is not None:
        await attachment_service.delete_readme_for_project(db, project_uid)
    else:
        await attachment_service.delete_readme_for_workspace(db, workspace_id)


# --- Wiki attachments (page / workspace-scoped) -----------------------------

wiki_router = APIRouter(prefix="/wiki-attachments", tags=["attachments"])


@wiki_router.get("", response_model=list[WikiAttachmentResponse])
async def list_wiki(
    page_id: str | None = Query(alias="pageId", default=None),
    workspace_id: str | None = Query(alias="workspaceId", default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if page_id is not None:
        atts = await attachment_service.list_wiki_by_page(db, page_id)
        if atts:
            await check_workspace_role(db, atts[0].workspace_id, user, "viewer")
        return atts
    if workspace_id is not None:
        await check_workspace_role(db, workspace_id, user, "viewer")
        return await attachment_service.list_wiki_by_workspace(db, workspace_id)
    raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "pageId or workspaceId required")


@wiki_router.post("", response_model=WikiAttachmentResponse, status_code=status.HTTP_201_CREATED)
async def create_wiki(
    request: Request,
    id: str = Query(),
    page_id: str = Query(alias="pageId"),
    workspace_id: str = Query(alias="workspaceId"),
    file_name: str = Query(alias="fileName"),
    mime_type: str = Query(alias="mimeType", default=""),
    created_at: str | None = Query(alias="createdAt", default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_role(db, workspace_id, user, "editor")
    data = await request.body()
    return await attachment_service.create_wiki(
        db, id=id, page_id=page_id, workspace_id=workspace_id, file_name=file_name,
        mime_type=mime_type, created_at=created_at, data=data,
    )


@wiki_router.get("/{att_id}/blob")
async def get_wiki_blob(
    att_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    att = await attachment_service.get_wiki(db, att_id)
    if att is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_role(db, att.workspace_id, user, "viewer")
    data = await blob_store.read_bytes(att.blob_sha)
    return Response(content=data, media_type=att.mime_type or "application/octet-stream",
                    headers={"x-file-name": att.file_name})


@wiki_router.delete("/{att_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_wiki(
    att_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    att = await attachment_service.get_wiki(db, att_id)
    if att is None:
        return
    await check_workspace_role(db, att.workspace_id, user, "editor")
    await attachment_service.delete_wiki(db, att)


@wiki_router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def delete_wiki_batch(
    page_id: str | None = Query(alias="pageId", default=None),
    workspace_id: str | None = Query(alias="workspaceId", default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if page_id is not None:
        atts = await attachment_service.list_wiki_by_page(db, page_id)
        if atts:
            await check_workspace_role(db, atts[0].workspace_id, user, "editor")
        await attachment_service.delete_wiki_for_page(db, page_id)
        return
    if workspace_id is not None:
        await check_workspace_role(db, workspace_id, user, "editor")
        await attachment_service.delete_wiki_for_workspace(db, workspace_id)
        return
    raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "pageId or workspaceId required")
