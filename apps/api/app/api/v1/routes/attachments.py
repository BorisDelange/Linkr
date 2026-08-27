from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_project_permission, check_workspace_permission
from app.models.data_catalog import DataCatalog
from app.models.data_source import DataSource
from app.models.dq_rule_set import DqRuleSet
from app.models.etl_pipeline import EtlPipeline
from app.models.mapping_project import MappingProject
from app.models.project import Project
from app.models.schema_preset import SchemaPreset
from app.models.sql_script import SqlScriptCollection
from app.models.user import User
from app.models.user_plugin import UserPlugin
from app.schemas.attachment import ReadmeAttachmentResponse, WikiAttachmentResponse
from app.services import attachment_service, blob_store

# Every documentable entity can carry README attachments. Each owner type maps to
# the model holding the owning row and the permission resource governing its
# documentation. Workspace-tier owners are authorized through their own
# workspace_id; project and workspace are special-cased below.
_OWNER_MODELS: dict[str, tuple[type, str]] = {
    "mapping-project": (MappingProject, "concept-mapping"),
    "sql-collection": (SqlScriptCollection, "sql-scripts"),
    "etl-pipeline": (EtlPipeline, "etl"),
    "dq-rule-set": (DqRuleSet, "data-quality"),
    "data-catalog": (DataCatalog, "catalog"),
    "schema-preset": (SchemaPreset, "schemas"),
    "user-plugin": (UserPlugin, "plugins"),
    # A database carries a README and a licence like every other entity — it is
    # the documentation whoever installs one from the catalog reads first. Its
    # absence here made every attachment call for one fail with "Unknown
    # ownerType: data-source", which aborted the whole import mid-way.
    "data-source": (DataSource, "databases"),
}


async def _require_readme_owner(
    db: AsyncSession, *, owner_type: str | None, owner_id: str | None,
    user: User, action: str,
) -> str | None:
    """Authorize a README-attachment operation against its owner and return the
    owner's workspace id (stamped server-side on create — never trusted from the
    client). `action` is "read" or "write": the documentation of an entity is part
    of its own resource, and summary resources have no delete action, so removal
    is a write."""
    if not owner_type or not owner_id:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "ownerType and ownerId required"
        )
    if owner_type == "workspace":
        await check_workspace_permission(
            db, owner_id, user, f"workspace-summary:{action}"
        )
        return owner_id
    if owner_type == "project":
        project = await db.get(Project, owner_id)
        if project is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
        await check_project_permission(db, project, user, f"project-summary:{action}")
        return project.workspace_id
    entry = _OWNER_MODELS.get(owner_type)
    if entry is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, f"Unknown ownerType: {owner_type}"
        )
    model, resource = entry
    entity = await db.get(model, owner_id)
    if entity is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Owner not found")
    workspace_id = entity.workspace_id
    if not workspace_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Owner has no workspace")
    await check_workspace_permission(db, workspace_id, user, f"{resource}:{action}")
    return workspace_id


# --- README attachments (polymorphic owner) ---------------------------------

readme_router = APIRouter(prefix="/readme-attachments", tags=["attachments"])


@readme_router.get("", response_model=list[ReadmeAttachmentResponse])
async def list_readme(
    owner_type: str | None = Query(alias="ownerType", default=None),
    owner_id: str | None = Query(alias="ownerId", default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_readme_owner(
        db, owner_type=owner_type, owner_id=owner_id, user=user, action="read"
    )
    return await attachment_service.list_readme_by_owner(db, owner_type, owner_id)


@readme_router.post("", response_model=ReadmeAttachmentResponse, status_code=status.HTTP_201_CREATED)
async def create_readme(
    request: Request,
    id: str = Query(),
    file_name: str = Query(alias="fileName"),
    owner_type: str | None = Query(alias="ownerType", default=None),
    owner_id: str | None = Query(alias="ownerId", default=None),
    mime_type: str = Query(alias="mimeType", default=""),
    created_at: str | None = Query(alias="createdAt", default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    workspace_id = await _require_readme_owner(
        db, owner_type=owner_type, owner_id=owner_id, user=user, action="write"
    )
    data = await request.body()
    return await attachment_service.create_readme(
        db, id=id, owner_type=owner_type, owner_id=owner_id, workspace_id=workspace_id,
        file_name=file_name, mime_type=mime_type, created_at=created_at, data=data,
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
    await _require_readme_owner(
        db, owner_type=att.owner_type, owner_id=att.owner_id, user=user, action="read"
    )
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
    await _require_readme_owner(
        db, owner_type=att.owner_type, owner_id=att.owner_id, user=user, action="write"
    )
    await attachment_service.delete_readme(db, att)


@readme_router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def delete_readme_batch(
    owner_type: str | None = Query(alias="ownerType", default=None),
    owner_id: str | None = Query(alias="ownerId", default=None),
    workspace_id: str | None = Query(alias="workspaceId", default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if workspace_id is not None and owner_type is None:
        # Wiping a whole workspace's attachments is a workspace-level operation
        # regardless of which entity types own them.
        await check_workspace_permission(
            db, workspace_id, user, "workspace-summary:write"
        )
        await attachment_service.delete_readme_for_workspace(db, workspace_id)
        return
    await _require_readme_owner(
        db, owner_type=owner_type, owner_id=owner_id, user=user, action="write"
    )
    await attachment_service.delete_readme_for_owner(db, owner_type, owner_id)


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
            await check_workspace_permission(db, atts[0].workspace_id, user, "wiki:read")
        return atts
    if workspace_id is not None:
        await check_workspace_permission(db, workspace_id, user, "wiki:read")
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
    await check_workspace_permission(db, workspace_id, user, "wiki:write")
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
    await check_workspace_permission(db, att.workspace_id, user, "wiki:read")
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
    await check_workspace_permission(db, att.workspace_id, user, "wiki:delete")
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
            await check_workspace_permission(db, atts[0].workspace_id, user, "wiki:delete")
        await attachment_service.delete_wiki_for_page(db, page_id)
        return
    if workspace_id is not None:
        await check_workspace_permission(db, workspace_id, user, "wiki:delete")
        await attachment_service.delete_wiki_for_workspace(db, workspace_id)
        return
    raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "pageId or workspaceId required")
