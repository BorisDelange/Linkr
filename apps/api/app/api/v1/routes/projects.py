from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import audit, deferred
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import (
    check_workspace_permission,
    require_project_permission,
)
from app.models.cohort import Cohort
from app.models.data_source import DataSource
from app.models.project import Project
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.project import (
    ProjectCreate,
    ProjectFolderBindings,
    ProjectResponse,
    ProjectUpdate,
)
from app.services import (
    change_tracking,
    database_binding,
    fs_browser,
    notification_service,
    project_service,
)

router = APIRouter(prefix="/projects", tags=["projects"])

# --- Notifications (writes by an external client, e.g. an agent over MCP) ---

# The versioning marks (`config`) and remote, re-saved by the git flow: the open
# page refreshes, the bell stays quiet.
_SIDE_FIELDS = {"config", "git_remote_config"}
_LINK_FIELDS = {"linked_data_source_ids", "linked_data_source_refs"}


async def _link_detail(db: AsyncSession, before: list[str] | None, after: list[str] | None) -> dict | None:
    """One database linked or unlinked, as a part of the change; None for anything else."""
    added, removed = set(after or []) - set(before or []), set(before or []) - set(after or [])
    if len(added) + len(removed) != 1:
        return None
    database = await db.get(DataSource, next(iter(added or removed)))
    return {"part": "database", "action": "linked" if added else "unlinked", "name": database.name if database else ""}


async def _notify(
    db: AsyncSession, request: Request, user: User, action: str, project: Project,
    *, detail: dict | None = None, notify: bool = True,
) -> None:
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request), action=action,
        entity_type="project", entity_id=project.uid, project_uid=project.uid, label=project.name,
        detail={"workspaceId": project.workspace_id, **(detail or {})}, notify=notify,
    )


@router.get("", response_model=list[ProjectResponse])
async def list_projects(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await project_service.list_for_user(db, user)


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: ProjectCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _check_target_workspace(db, body.workspace_id, user)
    await database_binding.require_bindable(db, body.workspace_id, user, body.linked_data_source_ids or [])
    project = await project_service.create(db, body, user)
    await _notify(db, request, user, "created", project)
    return project


async def _leave_links_behind(db: AsyncSession, project, body: ProjectUpdate, workspace_id: str) -> None:
    """A moving project keeps only the links its new workspace can honour. The
    pointers are index-aligned with the ids, so they go together."""
    ids = body.linked_data_source_ids if "linked_data_source_ids" in body.model_fields_set else project.linked_data_source_ids
    if not ids:
        return
    refs = body.linked_data_source_refs if "linked_data_source_refs" in body.model_fields_set else project.linked_data_source_refs
    keep = []
    for index, source_id in enumerate(ids):
        source = await db.get(DataSource, source_id)
        if source is not None and not database_binding.is_foreign(source, workspace_id):
            keep.append(index)
    body.linked_data_source_ids = [ids[i] for i in keep]
    body.linked_data_source_refs = [(refs or [])[i] for i in keep if i < len(refs or [])]


async def _leave_results_behind(db: AsyncSession, project, body: ProjectUpdate) -> None:
    """A moving project's cohorts drop what they computed on the databases of the
    workspace it leaves. A frozen membership does not record which database it
    came from, so every cohort's results go."""
    kept = set(body.linked_data_source_ids or []) if "linked_data_source_ids" in body.model_fields_set \
        else set(project.linked_data_source_ids or [])
    cohorts = (await db.execute(select(Cohort).where(Cohort.project_uid == project.uid))).scalars()
    for cohort in cohorts:
        cohort.materialization = None
        cohort.result_count = None
        cohort.attrition = None
        if cohort.data_source_id not in kept:
            cohort.data_source_id = None
            cohort.data_source_ref = None


async def _check_target_workspace(db: AsyncSession, workspace_id: str | None, user: User) -> None:
    """A project lands in a workspace only with projects:write there."""
    if workspace_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A project must belong to a workspace",
        )
    # The imported ZIP may reference a workspace that doesn't exist on this
    # instance; reject it cleanly instead of letting the FK insert 500.
    if await db.get(Workspace, workspace_id) is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Workspace not found",
        )
    await check_workspace_permission(db, workspace_id, user, "projects:write")


@router.get("/{project_uid}", response_model=ProjectResponse)
async def get_project(project=Depends(require_project_permission("project-summary:read"))):
    return project


@router.get("/{project_uid}/export-zip")
async def export_zip(
    project=Depends(require_project_permission("project-settings:read")),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Build the project's export ZIP server-side and return it for download — the
    same git-variant tree the versioning flow commits. Offloads the browser: no
    dataset data comes down just to be re-zipped. Data-file inclusion follows the
    project's versionedDataFiles marking. See docs/architecture.md."""
    from fastapi.responses import Response

    from app.core.permissions import unreadable_project_tree_reads
    from app.services.project_export import _slugify
    from app.services.project_export_assemble import assemble_project_zip

    if await unreadable_project_tree_reads(db, project, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This project holds content your role does not read")
    project_uid, workspace_id = project.uid, project.workspace_id
    name = project.name.get("en") if isinstance(project.name, dict) else project.name
    slug = _slugify(name or project_uid)

    async def work() -> Response:
        async with deferred.session() as session:
            fresh = await session.get(Project, project_uid)
            if fresh is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
            zip_bytes = await assemble_project_zip(session, fresh)
        audit.bind(action="export", project_uid=project_uid, workspace_id=workspace_id,
                   detail=f"project export ({len(zip_bytes)} bytes)")
        return Response(
            content=zip_bytes,
            media_type="application/zip",
            headers={"content-disposition": f'attachment; filename="{slug}.zip"'},
        )

    # A project with big datasets takes minutes to zip: past
    # `deferred.WAIT_SECONDS` it goes on as a job (core/deferred).
    return await deferred.respond(user.id, work, deferred.AsJob("Project export", project_uid=project_uid))


@router.patch("/{project_uid}", response_model=ProjectResponse)
async def update_project(
    body: ProjectUpdate,
    request: Request,
    project=Depends(require_project_permission("project-settings:write")),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    fields = body.model_dump(exclude_unset=True)
    if "workspace_id" in fields and fields["workspace_id"] != project.workspace_id:
        # Leaving a workspace takes the project out of its members' reach: the
        # source must allow it too, not just a project-level role.
        await check_workspace_permission(db, project.workspace_id, user, "projects:write")
        await _check_target_workspace(db, fields["workspace_id"], user)
    workspace_id = fields.get("workspace_id", project.workspace_id)
    if workspace_id != project.workspace_id:
        await _leave_links_behind(db, project, body, workspace_id)
    added = [i for i in fields.get("linked_data_source_ids") or [] if i not in (project.linked_data_source_ids or [])]
    await database_binding.require_bindable(db, workspace_id, user, added, project=project)
    if workspace_id != project.workspace_id:
        await _leave_results_behind(db, project, body)
    fields = body.model_dump(exclude_unset=True)
    before = change_tracking.changed_values(project, fields)
    project = await project_service.update(db, project, body, user)
    if before:
        link = None
        if before.keys() <= _LINK_FIELDS and "linked_data_source_ids" in before:
            link = await _link_detail(db, before["linked_data_source_ids"], project.linked_data_source_ids)
        await _notify(db, request, user, "updated", project, detail=link, notify=not before.keys() <= _SIDE_FIELDS)
    return project


@router.patch("/{project_uid}/folder-bindings", response_model=ProjectResponse)
async def update_folder_bindings(
    body: ProjectFolderBindings,
    request: Request,
    project=Depends(require_project_permission("project-settings:write")),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    fields = body.model_dump(exclude_unset=True)
    # Enforce the browse-root boundary at the point of persistence, not just in the
    # picker (client-side validation is not a security control). Rejects an
    # out-of-roots / non-existent bind before it reaches the IDE/dataset file routes.
    bindings = [path for path in fields.values() if path]
    if bindings:
        await fs_browser.require_unconfined_reach(db, project, user)
        scope = await fs_browser.import_scope(db, project, user)
        for path in bindings:
            try:
                fs_browser.validate_binding_path(path, scope)
            except fs_browser.FsBrowseError as exc:
                raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    before = change_tracking.changed_values(project, fields)
    project = await project_service.set_folder_bindings(db, project, fields)
    if before:
        await _notify(db, request, user, "updated", project)
    return project


@router.delete("/{project_uid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project=Depends(require_project_permission("project-settings:delete")),
    db: AsyncSession = Depends(get_db),
):
    await project_service.delete(db, project)
