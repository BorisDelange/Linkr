from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import require_global_permission, require_permission
from app.models.user import User
from app.schemas.workspace import (
    WorkspaceCreate,
    WorkspaceResponse,
    WorkspaceUpdate,
)
from app.services import workspace_service

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


class WorkspaceExportRequest(BaseModel):
    """Mirrors the frontend ``BuildWorkspaceZipOptions``: which sections to include,
    per-entity data opt-in, per-entity exclude opt-out, and the database-credentials
    opt-in. Absent keys default to the whole-workspace export (all sections on)."""

    sections: dict[str, bool] = Field(default_factory=dict)
    include_entity_data: dict[str, bool] = Field(default_factory=dict, alias="includeEntityData")
    exclude_entities: dict[str, bool] = Field(default_factory=dict, alias="excludeEntities")
    include_credentials: bool = Field(default=False, alias="includeCredentials")


@router.get("", response_model=list[WorkspaceResponse])
async def list_workspaces(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await workspace_service.list_for_user(db, user)


@router.post("", response_model=WorkspaceResponse, status_code=status.HTTP_201_CREATED)
async def create_workspace(
    body: WorkspaceCreate,
    user: User = Depends(require_global_permission("workspaces:write")),
    db: AsyncSession = Depends(get_db),
):
    # Creating a workspace is a global-tier right (admin, or a role granted
    # "workspaces:write"). The creator becomes its owner (see the service).
    return await workspace_service.create(db, body, user)


@router.get(
    "/{workspace_id}",
    response_model=WorkspaceResponse,
    dependencies=[Depends(require_permission("workspace-summary:read"))],
)
async def get_workspace(workspace_id: str, db: AsyncSession = Depends(get_db)):
    workspace = await workspace_service.get(db, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return workspace


@router.post(
    "/{workspace_id}/export-zip",
    dependencies=[Depends(require_permission("workspace-settings:read"))],
)
async def export_zip(
    workspace_id: str,
    body: WorkspaceExportRequest | None = None,
    db: AsyncSession = Depends(get_db),
):
    """Build the workspace's export ZIP server-side and return it for download —
    the same git-variant tree the versioning flow commits, honoring the export
    dialog's section / per-entity data / exclude / credentials toggles. Offloads the
    browser: it no longer reads every entity's data just to re-zip it. See
    docs/planning/server-export-plan.md §8 step 4. POST (not GET) because the
    options are a structured body."""
    from fastapi.responses import Response

    from app.services.workspace_export import _slugify
    from app.services.workspace_export_assemble import (
        WorkspaceExportOptions,
        assemble_workspace_zip,
    )

    workspace = await workspace_service.get(db, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    opts = body or WorkspaceExportRequest()
    options = WorkspaceExportOptions(
        sections=opts.sections,
        include_entity_data=opts.include_entity_data,
        exclude_entities=opts.exclude_entities,
        include_credentials=opts.include_credentials,
    )
    zip_bytes = await assemble_workspace_zip(db, workspace, options)
    name = workspace.name.get("en") if isinstance(workspace.name, dict) else workspace.name
    slug = _slugify(name or workspace.id)
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"content-disposition": f'attachment; filename="{slug}.zip"'},
    )


@router.patch(
    "/{workspace_id}",
    response_model=WorkspaceResponse,
    dependencies=[Depends(require_permission("workspace-settings:write"))],
)
async def update_workspace(
    workspace_id: str,
    body: WorkspaceUpdate,
    db: AsyncSession = Depends(get_db),
):
    workspace = await workspace_service.get(db, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return await workspace_service.update(db, workspace, body)


@router.delete(
    "/{workspace_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_permission("workspace-settings:delete"))],
)
async def delete_workspace(workspace_id: str, db: AsyncSession = Depends(get_db)):
    workspace = await workspace_service.get(db, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    await workspace_service.delete(db, workspace)
