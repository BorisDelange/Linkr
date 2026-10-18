from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import audit, deferred
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import require_global_permission, require_permission
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.workspace import (
    WorkspaceCreate,
    WorkspaceResponse,
    WorkspaceUpdate,
)
from app.services import notification_service, workspace_service

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


# The versioning remote, re-saved by the git flow (and sealed, so never equal to
# what was sent): the open page refreshes, the bell stays quiet.
_SIDE_FIELDS = {"git_remote_config"}


def _previous(row, changes: dict) -> dict:
    """The values `changes` actually alters, as they were before the write."""
    return {k: getattr(row, k) for k, v in changes.items() if getattr(row, k) != v}


async def _notify(
    db: AsyncSession, request: Request, user: User, action: str, workspace: Workspace, *, notify: bool = True,
) -> None:
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request), action=action,
        entity_type="workspace", entity_id=workspace.id, project_uid=None, label=workspace.name,
        detail={"workspaceId": workspace.id}, notify=notify,
    )


class WorkspaceExportRequest(BaseModel):
    """Mirrors the frontend ``BuildWorkspaceZipOptions``: which sections to include
    and the per-entity exclude opt-out. Absent keys default to the whole-workspace
    export (all sections on). Connection details are never exported; data files are
    included only when marked for versioning."""

    sections: dict[str, bool] = Field(default_factory=dict)
    exclude_entities: dict[str, bool] = Field(default_factory=dict, alias="excludeEntities")


@router.get("", response_model=list[WorkspaceResponse])
async def list_workspaces(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await workspace_service.list_for_user(db, user)


@router.post("", response_model=WorkspaceResponse, status_code=status.HTTP_201_CREATED)
async def create_workspace(
    body: WorkspaceCreate,
    request: Request,
    user: User = Depends(require_global_permission("workspaces:write")),
    db: AsyncSession = Depends(get_db),
):
    # Creating a workspace is a global-tier right (admin, or a role granted
    # "workspaces:write"). The creator becomes its owner (see the service).
    workspace = await workspace_service.create(db, body, user)
    await _notify(db, request, user, "created", workspace)
    return workspace


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
    user: User = Depends(get_current_user),
):
    """Build the workspace's export ZIP server-side and return it for download —
    the same git-variant tree the versioning flow commits, honoring the export
    dialog's section / per-entity exclude toggles. Offloads the browser: it no
    longer reads every entity's data just to re-zip it. See docs/architecture.md
    ("Fullstack Storage & Compute"). POST (not GET) because the options are a
    structured body."""
    from fastapi.responses import Response

    from app.services.export_masking import SourceConceptsUnreadable
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
        exclude_entities=opts.exclude_entities,
    )
    name = workspace.name.get("en") if isinstance(workspace.name, dict) else workspace.name
    slug = _slugify(name or workspace.id)

    async def work() -> Response:
        async with deferred.session() as session:
            fresh = await workspace_service.get(session, workspace_id)
            if fresh is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
            try:
                zip_bytes = await assemble_workspace_zip(session, fresh, options)
            except SourceConceptsUnreadable as e:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
        audit.bind(action="export", workspace_id=workspace_id,
                   detail=f"workspace export ({len(zip_bytes)} bytes)")
        return Response(
            content=zip_bytes,
            media_type="application/zip",
            headers={"content-disposition": f'attachment; filename="{slug}.zip"'},
        )

    # A workspace with big datasets takes minutes to zip: past
    # `deferred.WAIT_SECONDS` it goes on as a job (core/deferred).
    return await deferred.respond(user.id, work, deferred.AsJob("Workspace export", workspace_id=workspace_id))


@router.patch(
    "/{workspace_id}",
    response_model=WorkspaceResponse,
    dependencies=[Depends(require_permission("workspace-settings:write"))],
)
async def update_workspace(
    workspace_id: str,
    body: WorkspaceUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    workspace = await workspace_service.get(db, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    changed = _previous(workspace, body.model_dump(exclude_unset=True))
    workspace = await workspace_service.update(db, workspace, body)
    if changed:
        await _notify(db, request, user, "updated", workspace, notify=not changed.keys() <= _SIDE_FIELDS)
    return workspace


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
