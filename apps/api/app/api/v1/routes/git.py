"""Server-side git versioning endpoints (push-only) for projects & workspaces.

Each op needs the entity's export ZIP. For mapping projects the server now BUILDS
it (assemble_mapping_project_zip) when the client sends no file — the fullstack
path that offloads the browser; an uploaded file is still accepted (front-only /
transition). Other scopes still receive the client-built ZIP. The router unpacks
the ZIP into the entity's git working tree and runs the requested git operation
(status / diff / commit+push / branch list). Clone is used by the import flow to
pull a remote in server mode (no in-browser CORS proxy needed).

Read ops (status/diff/branches) require viewer; write ops (commit/push) require
editor. Access tokens are stored per (user, host) by git_credential_service and
resolved for the acting user from the remote URL — never per entity, so one user
never pushes with another's token. Tokens are decrypted server-side and never
leave the server.
"""

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_admin, get_current_user
from app.core.permissions import require_project_permission, require_permission
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.git import (
    GitBranchesResponse,
    GitCloneRequest,
    GitCommitResponse,
    GitDiffResponse,
    GitHostTokenRequest,
    GitHostTokenStatus,
    GitPullPreviewResponse,
    GitSetSyncStateRequest,
    GitStatusResponse,
    GitSyncStateResponse,
    GitVerifyRequest,
    GitVerifyResponse,
    SettingsGitConfig,
    SettingsGitConfigResponse,
    SettingsImportResponse,
    SettingsPullPreview,
)
from app.services import (
    app_settings_service,
    git_credential_service,
    git_service,
    git_sync_state_service,
    settings_import_service,
    workspace_service,
)
from app.services.mapping_project_export_assemble import assemble_mapping_project_zip
from app.services.project_export_assemble import assemble_project_zip
from app.services.settings_export_assemble import (
    SettingsSelection,
    assemble_settings_zip,
)
from app.services.workspace_export_assemble import (
    WorkspaceExportOptions,
    assemble_workspace_zip,
)

router = APIRouter(prefix="/git", tags=["git"])


async def _mapping_project_zip_bytes(db, mp, file: UploadFile | None) -> bytes:
    """The mapping project's export ZIP: server-built when the client sends no
    file (the fullstack path that offloads the browser), else the uploaded bytes
    (front-only / transition). Both feed the same git flow."""
    if file is not None:
        return await file.read()
    return await assemble_mapping_project_zip(db, mp)


async def _workspace_zip_bytes(db, ws, file: UploadFile | None) -> bytes:
    """The workspace's export ZIP: server-built when the client sends no file (the
    fullstack path that offloads the browser), else the uploaded bytes (front-only
    / transition). The git flow always versions the full workspace (all sections,
    no per-entity data, no excludes) — the section/include-data/exclude toggles are
    an Export-button concern, not a git-sync one (the client's git buildZip never
    forwards them), so the default options reproduce what the front committed."""
    if file is not None:
        return await file.read()
    return await assemble_workspace_zip(db, ws, WorkspaceExportOptions())


async def _sql_collection_zip_bytes(db, collection, file: UploadFile | None) -> bytes:
    """The SQL collection's export ZIP: server-built when the client sends no file
    (fullstack path), else the uploaded bytes (front-only / transition)."""
    if file is not None:
        return await file.read()
    from app.services.workspace_export_assemble import assemble_sql_collection_zip

    return await assemble_sql_collection_zip(db, collection)


async def _project_zip_bytes(
    db, project, file: UploadFile | None, include_data: bool
) -> bytes:
    """The project's export ZIP: server-built when the client sends no file (the
    fullstack path that offloads the browser), else the uploaded bytes (front-only
    / transition). ``include_data`` mirrors the panel's include-data toggle —
    baked into the ZIP by the client build, so the server reproduces it here."""
    if file is not None:
        return await file.read()
    return await assemble_project_zip(db, project, include_data)


def _git_http_error(exc: git_service.GitError) -> HTTPException:
    """A structured 400 the UI can turn into a friendly message: `code` is the
    stable label, `message` the raw (scrubbed) git output shown on demand."""
    return HTTPException(
        status.HTTP_400_BAD_REQUEST,
        detail={"code": getattr(exc, "code", "unknown"), "message": str(exc)},
    )


async def _guard(coro) -> dict:
    """Run a git service coroutine, mapping GitError → structured 400."""
    try:
        return await coro
    except git_service.GitError as exc:
        raise _git_http_error(exc) from exc


def _remote_url(entity) -> str | None:
    cfg = getattr(entity, "git_remote_config", None) or {}
    return cfg.get("url") or None


async def _token(db: AsyncSession, user: User, entity) -> str | None:
    """The acting user's git token for this entity's remote host (per-user, not
    per-entity), or None when the entity is unlinked or the user has no token."""
    return await git_credential_service.token_for_url(db, user, _remote_url(entity))


async def _sync_state(
    db, scope, repo_getter, entity_id, branch, remote_url, token
) -> dict:
    """Run the git sync-state check (behind/diverged) reading the DB anchor. No ZIP:
    the check only compares oids on the remote, so the client needn't rebuild the
    export just to learn it's out of date."""
    row = await git_sync_state_service.get(db, scope, entity_id, branch)
    result = await _guard(
        git_service.sync_state(
            repo_getter,
            entity_id,
            branch,
            remote_url,
            row.synced_oid if row else None,
            token,
        )
    )
    return {"linked": remote_url is not None, "branch": branch, **result}


def _default_branch(entity, fallback: str | None) -> str:
    if fallback:
        return fallback
    cfg = getattr(entity, "git_remote_config", None) or {}
    return cfg.get("branch") or "main"


# --- Project scope --------------------------------------------------------


@router.post("/projects/{project_uid}/status", response_model=GitStatusResponse)
async def project_status(
    file: UploadFile | None = File(None),
    branch: str | None = Form(None),
    include_data: bool = Form(False),
    project=Depends(require_project_permission("project-settings:read")),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await _guard(
        git_service.status(
            git_service.project_repo_getter,
            project.uid,
            await _project_zip_bytes(db, project, file, include_data),
            _default_branch(project, branch),
            _remote_url(project),
            await _token(db, user, project),
        )
    )
    return {"linked": _remote_url(project) is not None, **result}


@router.post("/projects/{project_uid}/diff", response_model=GitDiffResponse)
async def project_diff(
    file: UploadFile | None = File(None),
    path: str = Form(...),
    branch: str | None = Form(None),
    include_data: bool = Form(False),
    project=Depends(require_project_permission("project-settings:read")),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await _guard(
        git_service.diff(
            git_service.project_repo_getter,
            project.uid,
            await _project_zip_bytes(db, project, file, include_data),
            _default_branch(project, branch),
            path,
            _remote_url(project),
            await _token(db, user, project),
        )
    )


@router.get("/projects/{project_uid}/branches", response_model=GitBranchesResponse)
async def project_branches(
    project=Depends(require_project_permission("project-settings:read")),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await git_service.branches(
        git_service.project_repo_getter,
        project.uid,
        _remote_url(project),
        await _token(db, user, project),
    )


@router.post("/projects/{project_uid}/commit-push", response_model=GitCommitResponse)
async def project_commit_push(
    file: UploadFile | None = File(None),
    message: str = Form(...),
    branch: str | None = Form(None),
    paths: list[str] | None = Form(None),
    include_data: bool = Form(False),
    project=Depends(require_project_permission("project-settings:write")),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if _remote_url(project) is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Project is not linked to a git remote"
        )
    return await _guard(
        git_service.commit_push(
            git_service.project_repo_getter,
            project.uid,
            await _project_zip_bytes(db, project, file, include_data),
            _default_branch(project, branch),
            message,
            _remote_url(project),
            await _token(db, user, project),
            paths,
        )
    )


@router.get(
    "/projects/{project_uid}/sync-state",
    response_model=GitSyncStateResponse,
)
async def project_sync_state(
    branch: str | None = None,
    project=Depends(require_project_permission("project-settings:read")),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Where the local project stands vs the remote branch (behind/diverged),
    reading the DB anchor. No ZIP — the check only compares remote oids, so the
    client needn't rebuild the export just to learn it's out of date."""
    return await _sync_state(
        db,
        "projects",
        git_service.project_repo_getter,
        project.uid,
        _default_branch(project, branch),
        _remote_url(project),
        await _token(db, user, project),
    )


@router.post(
    "/projects/{project_uid}/set-sync-state",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def project_set_sync_state(
    body: GitSetSyncStateRequest,
    project=Depends(require_project_permission("project-settings:write")),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Anchor the project's sync state to a known remote commit — called after a
    git import or a pull so it has a base to compare against (a later push
    elsewhere is then detected as 'behind'). Write access required."""
    await git_sync_state_service.set_oid(
        db, "projects", project.uid, body.branch, body.synced_oid
    )


# --- Workspace scope ------------------------------------------------------


async def _load_workspace(workspace_id: str, db: AsyncSession, _member) -> Workspace:
    ws = await workspace_service.get(db, workspace_id)
    if ws is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")
    return ws


@router.post("/workspaces/{workspace_id}/status", response_model=GitStatusResponse)
async def workspace_status(
    workspace_id: str,
    file: UploadFile | None = File(None),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    _member=Depends(require_permission("workspace-settings:read")),
):
    ws = await _load_workspace(workspace_id, db, _member)
    result = await _guard(
        git_service.status(
            git_service.workspace_repo_getter,
            ws.id,
            await _workspace_zip_bytes(db, ws, file),
            _default_branch(ws, branch),
            _remote_url(ws),
            await _token(db, _member, ws),
        )
    )
    return {"linked": _remote_url(ws) is not None, **result}


@router.post("/workspaces/{workspace_id}/diff", response_model=GitDiffResponse)
async def workspace_diff(
    workspace_id: str,
    file: UploadFile | None = File(None),
    path: str = Form(...),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    _member=Depends(require_permission("workspace-settings:read")),
):
    ws = await _load_workspace(workspace_id, db, _member)
    return await _guard(
        git_service.diff(
            git_service.workspace_repo_getter,
            ws.id,
            await _workspace_zip_bytes(db, ws, file),
            _default_branch(ws, branch),
            path,
            _remote_url(ws),
            await _token(db, _member, ws),
        )
    )


@router.get("/workspaces/{workspace_id}/branches", response_model=GitBranchesResponse)
async def workspace_branches(
    workspace_id: str,
    db: AsyncSession = Depends(get_db),
    _member=Depends(require_permission("workspace-settings:read")),
):
    ws = await _load_workspace(workspace_id, db, _member)
    return await git_service.branches(
        git_service.workspace_repo_getter,
        ws.id,
        _remote_url(ws),
        await _token(db, _member, ws),
    )


@router.post("/workspaces/{workspace_id}/commit-push", response_model=GitCommitResponse)
async def workspace_commit_push(
    workspace_id: str,
    file: UploadFile | None = File(None),
    message: str = Form(...),
    branch: str | None = Form(None),
    paths: list[str] | None = Form(None),
    db: AsyncSession = Depends(get_db),
    _member=Depends(require_permission("workspace-settings:write")),
):
    ws = await _load_workspace(workspace_id, db, _member)
    if _remote_url(ws) is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Workspace is not linked to a git remote"
        )
    return await _guard(
        git_service.commit_push(
            git_service.workspace_repo_getter,
            ws.id,
            await _workspace_zip_bytes(db, ws, file),
            _default_branch(ws, branch),
            message,
            _remote_url(ws),
            await _token(db, _member, ws),
            paths,
        )
    )


# --- Mapping project scope ------------------------------------------------


async def _load_mapping_project(
    mapping_project_id: str, db: AsyncSession, user: User, permission: str
):
    from app.core.permissions import check_workspace_permission
    from app.services import mapping_project_service

    mp = await mapping_project_service.get(db, mapping_project_id)
    if mp is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Mapping project not found")
    await check_workspace_permission(db, mp.workspace_id, user, permission)
    return mp


@router.post(
    "/mapping-projects/{mapping_project_id}/status", response_model=GitStatusResponse
)
async def mapping_project_status(
    mapping_project_id: str,
    file: UploadFile | None = File(None),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    mp = await _load_mapping_project(
        mapping_project_id, db, user, "concept-mapping:read"
    )
    result = await _guard(
        git_service.status(
            git_service.mapping_project_repo_getter,
            mp.id,
            await _mapping_project_zip_bytes(db, mp, file),
            _default_branch(mp, branch),
            _remote_url(mp),
            await _token(db, user, mp),
        )
    )
    return {"linked": _remote_url(mp) is not None, **result}


@router.post(
    "/mapping-projects/{mapping_project_id}/diff", response_model=GitDiffResponse
)
async def mapping_project_diff(
    mapping_project_id: str,
    file: UploadFile | None = File(None),
    path: str = Form(...),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    mp = await _load_mapping_project(
        mapping_project_id, db, user, "concept-mapping:read"
    )
    return await _guard(
        git_service.diff(
            git_service.mapping_project_repo_getter,
            mp.id,
            await _mapping_project_zip_bytes(db, mp, file),
            _default_branch(mp, branch),
            path,
            _remote_url(mp),
            await _token(db, user, mp),
        )
    )


@router.get(
    "/mapping-projects/{mapping_project_id}/branches",
    response_model=GitBranchesResponse,
)
async def mapping_project_branches(
    mapping_project_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    mp = await _load_mapping_project(
        mapping_project_id, db, user, "concept-mapping:read"
    )
    return await git_service.branches(
        git_service.mapping_project_repo_getter,
        mp.id,
        _remote_url(mp),
        await _token(db, user, mp),
    )


@router.get(
    "/mapping-projects/{mapping_project_id}/sync-state",
    response_model=GitSyncStateResponse,
)
async def mapping_project_sync_state(
    mapping_project_id: str,
    branch: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    mp = await _load_mapping_project(
        mapping_project_id, db, user, "concept-mapping:read"
    )
    return await _sync_state(
        db,
        "mapping-projects",
        git_service.mapping_project_repo_getter,
        mp.id,
        _default_branch(mp, branch),
        _remote_url(mp),
        await _token(db, user, mp),
    )


@router.get(
    "/mapping-projects/{mapping_project_id}/pull-preview",
    response_model=GitPullPreviewResponse,
)
async def mapping_project_pull_preview(
    mapping_project_id: str,
    branch: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Fetch BASE + REMOTE managed-file content so the client can 3-way merge them
    against its DB (LOCAL) and present a resolution UI. Read access is enough — the
    pull only writes the DB once the user resolves (via the entity's own APIs)."""
    mp = await _load_mapping_project(
        mapping_project_id, db, user, "concept-mapping:read"
    )
    row = await git_sync_state_service.get(
        db, "mapping-projects", mp.id, _default_branch(mp, branch)
    )
    return await _guard(
        git_service.pull_preview(
            git_service.mapping_project_repo_getter,
            mp.id,
            _default_branch(mp, branch),
            _remote_url(mp),
            row.synced_oid if row else None,
            await _token(db, user, mp),
        )
    )


@router.get("/mapping-projects/{mapping_project_id}/pull-file")
async def mapping_project_pull_file(
    mapping_project_id: str,
    path: str,
    branch: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Stream the raw bytes of a managed file (source CSV, scores parquet) at the
    remote head, LFS resolved — used when the pull's block choice is 'take remote'
    for a whole-list family. Only the pull's managed heavy files are allowed."""
    from fastapi.responses import Response

    if path not in ("source-concepts.csv", "similarity-scores.parquet"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "path is not a pullable file")
    mp = await _load_mapping_project(
        mapping_project_id, db, user, "concept-mapping:read"
    )
    data = await _guard(
        git_service.pull_file_bytes(
            git_service.mapping_project_repo_getter,
            mp.id,
            _default_branch(mp, branch),
            path,
            _remote_url(mp),
            await _token(db, user, mp),
        )
    )
    return Response(content=data, media_type="application/octet-stream")


@router.post(
    "/mapping-projects/{mapping_project_id}/set-sync-state",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def mapping_project_set_sync_state(
    mapping_project_id: str,
    body: GitSetSyncStateRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Anchor the entity's sync state to a known remote commit — called right after
    a git import so the freshly-created project has a base to compare against (a
    later push elsewhere is then detected as 'behind'). Write access required."""
    mp = await _load_mapping_project(
        mapping_project_id, db, user, "concept-mapping:write"
    )
    await git_sync_state_service.set_oid(
        db, "mapping-projects", mp.id, body.branch, body.synced_oid
    )


@router.post(
    "/mapping-projects/{mapping_project_id}/commit-push",
    response_model=GitCommitResponse,
)
async def mapping_project_commit_push(
    mapping_project_id: str,
    file: UploadFile | None = File(None),
    message: str = Form(...),
    branch: str | None = Form(None),
    paths: list[str] | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    mp = await _load_mapping_project(
        mapping_project_id, db, user, "concept-mapping:write"
    )
    if _remote_url(mp) is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Mapping project is not linked to a git remote"
        )
    resolved_branch = _default_branch(mp, branch)
    row = await git_sync_state_service.get(
        db, "mapping-projects", mp.id, resolved_branch
    )
    result = await _guard(
        git_service.commit_push(
            git_service.mapping_project_repo_getter,
            mp.id,
            await _mapping_project_zip_bytes(db, mp, file),
            resolved_branch,
            message,
            _remote_url(mp),
            await _token(db, user, mp),
            paths,
            row.synced_oid if row else None,
        )
    )
    # A successful push means the pushed commit is now the synced point → move the anchor.
    if result.get("pushed") and result.get("commit"):
        await git_sync_state_service.set_oid(
            db,
            "mapping-projects",
            mp.id,
            resolved_branch,
            result["commit"]["oid"],
        )
    return result


# --- SQL script collection scope ------------------------------------------


async def _load_sql_collection(
    collection_id: str, db: AsyncSession, user: User, permission: str
):
    from app.core.permissions import check_workspace_permission
    from app.services import sql_script_service

    collection = await sql_script_service.get(db, collection_id)
    if collection is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "SQL script collection not found"
        )
    await check_workspace_permission(db, collection.workspace_id, user, permission)
    return collection


@router.post(
    "/sql-script-collections/{collection_id}/status", response_model=GitStatusResponse
)
async def sql_collection_status(
    collection_id: str,
    file: UploadFile | None = File(None),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = await _load_sql_collection(collection_id, db, user, "sql-scripts:read")
    result = await _guard(
        git_service.status(
            git_service.sql_collection_repo_getter,
            c.id,
            await _sql_collection_zip_bytes(db, c, file),
            _default_branch(c, branch),
            _remote_url(c),
            await _token(db, user, c),
        )
    )
    return {"linked": _remote_url(c) is not None, **result}


@router.post(
    "/sql-script-collections/{collection_id}/diff", response_model=GitDiffResponse
)
async def sql_collection_diff(
    collection_id: str,
    file: UploadFile | None = File(None),
    path: str = Form(...),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = await _load_sql_collection(collection_id, db, user, "sql-scripts:read")
    return await _guard(
        git_service.diff(
            git_service.sql_collection_repo_getter,
            c.id,
            await _sql_collection_zip_bytes(db, c, file),
            _default_branch(c, branch),
            path,
            _remote_url(c),
            await _token(db, user, c),
        )
    )


@router.get(
    "/sql-script-collections/{collection_id}/branches",
    response_model=GitBranchesResponse,
)
async def sql_collection_branches(
    collection_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = await _load_sql_collection(collection_id, db, user, "sql-scripts:read")
    return await git_service.branches(
        git_service.sql_collection_repo_getter,
        c.id,
        _remote_url(c),
        await _token(db, user, c),
    )


@router.post(
    "/sql-script-collections/{collection_id}/commit-push",
    response_model=GitCommitResponse,
)
async def sql_collection_commit_push(
    collection_id: str,
    file: UploadFile | None = File(None),
    message: str = Form(...),
    branch: str | None = Form(None),
    paths: list[str] | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = await _load_sql_collection(collection_id, db, user, "sql-scripts:write")
    if _remote_url(c) is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "SQL script collection is not linked to a git remote",
        )
    return await _guard(
        git_service.commit_push(
            git_service.sql_collection_repo_getter,
            c.id,
            await _sql_collection_zip_bytes(db, c, file),
            _default_branch(c, branch),
            message,
            _remote_url(c),
            await _token(db, user, c),
            paths,
        )
    )


# --- Workspace-scoped entities (ETL / catalog / DQ / plugins / schema presets) ---
#
# These five share the SQL-collection shape exactly: one repo per entity, a
# service.get() loader, a workspace-permission check, and the four generic git
# ops. Rather than repeat ~90 lines each, a small factory registers the routes
# from a per-entity spec (loader + repo getter + read/write permission strings).


async def _load_workspace_entity(get_fn, entity_id, db, user, permission, not_found):
    from app.core.permissions import check_workspace_permission

    entity = await get_fn(db, entity_id)
    if entity is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, not_found)
    if entity.workspace_id is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"{not_found} has no workspace"
        )
    await check_workspace_permission(db, entity.workspace_id, user, permission)
    return entity


def _register_entity_git_routes(
    *, prefix, get_fn, repo_getter, read_perm, write_perm, not_found, assemble_fn=None
):
    """Add status/diff/branches/commit-push for a workspace-scoped entity.

    ``assemble_fn(db, entity) -> bytes`` builds the export ZIP server-side when the
    client sends no file (the fullstack path that offloads the browser), mirroring
    project/mapping/workspace. When absent, a file upload is required (front-only)."""

    async def _zip_bytes(db, e, file: UploadFile | None) -> bytes:
        if file is not None:
            return await file.read()
        if assemble_fn is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "no export file provided"
            )
        return await assemble_fn(db, e)

    @router.post(
        f"/{prefix}/{{entity_id}}/status",
        response_model=GitStatusResponse,
        name=f"{prefix}_status",
    )
    async def _status(
        entity_id: str,
        file: UploadFile | None = File(None),
        branch: str | None = Form(None),
        db: AsyncSession = Depends(get_db),
        user: User = Depends(get_current_user),
    ):
        e = await _load_workspace_entity(
            get_fn, entity_id, db, user, read_perm, not_found
        )
        result = await _guard(
            git_service.status(
                repo_getter,
                _entity_id(e),
                await _zip_bytes(db, e, file),
                _default_branch(e, branch),
                _remote_url(e),
                await _token(db, user, e),
            )
        )
        return {"linked": _remote_url(e) is not None, **result}

    @router.post(
        f"/{prefix}/{{entity_id}}/diff",
        response_model=GitDiffResponse,
        name=f"{prefix}_diff",
    )
    async def _diff(
        entity_id: str,
        file: UploadFile | None = File(None),
        path: str = Form(...),
        branch: str | None = Form(None),
        db: AsyncSession = Depends(get_db),
        user: User = Depends(get_current_user),
    ):
        e = await _load_workspace_entity(
            get_fn, entity_id, db, user, read_perm, not_found
        )
        return await _guard(
            git_service.diff(
                repo_getter,
                _entity_id(e),
                await _zip_bytes(db, e, file),
                _default_branch(e, branch),
                path,
                _remote_url(e),
                await _token(db, user, e),
            )
        )

    @router.get(
        f"/{prefix}/{{entity_id}}/branches",
        response_model=GitBranchesResponse,
        name=f"{prefix}_branches",
    )
    async def _branches(
        entity_id: str,
        db: AsyncSession = Depends(get_db),
        user: User = Depends(get_current_user),
    ):
        e = await _load_workspace_entity(
            get_fn, entity_id, db, user, read_perm, not_found
        )
        return await git_service.branches(
            repo_getter, _entity_id(e), _remote_url(e), await _token(db, user, e)
        )

    @router.post(
        f"/{prefix}/{{entity_id}}/commit-push",
        response_model=GitCommitResponse,
        name=f"{prefix}_commit_push",
    )
    async def _commit_push(
        entity_id: str,
        file: UploadFile | None = File(None),
        message: str = Form(...),
        branch: str | None = Form(None),
        paths: list[str] | None = Form(None),
        db: AsyncSession = Depends(get_db),
        user: User = Depends(get_current_user),
    ):
        e = await _load_workspace_entity(
            get_fn, entity_id, db, user, write_perm, not_found
        )
        if _remote_url(e) is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"{not_found} is not linked to a git remote",
            )
        return await _guard(
            git_service.commit_push(
                repo_getter,
                _entity_id(e),
                await _zip_bytes(db, e, file),
                _default_branch(e, branch),
                message,
                _remote_url(e),
                await _token(db, user, e),
                paths,
            )
        )


def _entity_id(entity):
    """The repo key. Most entities key on `id`; schema presets key on `preset_id`."""
    return getattr(entity, "id", None) or entity.preset_id


def _register_all_entity_git_routes() -> None:
    from app.services import (
        data_catalog_service,
        dq_rule_set_service,
        etl_pipeline_service,
        schema_preset_service,
        user_plugin_service,
    )
    from app.services.workspace_export_assemble import (
        assemble_data_catalog_zip,
        assemble_dq_rule_set_zip,
        assemble_etl_pipeline_zip,
        assemble_schema_preset_zip,
        assemble_user_plugin_zip,
    )

    _register_entity_git_routes(
        prefix="etl-pipelines",
        get_fn=etl_pipeline_service.get,
        repo_getter=git_service.etl_pipeline_repo_getter,
        read_perm="etl:read",
        write_perm="etl:write",
        not_found="ETL pipeline not found",
        assemble_fn=assemble_etl_pipeline_zip,
    )
    _register_entity_git_routes(
        prefix="data-catalogs",
        get_fn=data_catalog_service.get,
        repo_getter=git_service.data_catalog_repo_getter,
        read_perm="catalog:read",
        write_perm="catalog:write",
        not_found="Data catalog not found",
        assemble_fn=assemble_data_catalog_zip,
    )
    _register_entity_git_routes(
        prefix="dq-rule-sets",
        get_fn=dq_rule_set_service.get,
        repo_getter=git_service.dq_rule_set_repo_getter,
        read_perm="data-quality:read",
        write_perm="data-quality:write",
        not_found="DQ rule set not found",
        assemble_fn=assemble_dq_rule_set_zip,
    )
    _register_entity_git_routes(
        prefix="user-plugins",
        get_fn=user_plugin_service.get,
        repo_getter=git_service.user_plugin_repo_getter,
        read_perm="plugins:read",
        write_perm="plugins:write",
        not_found="Plugin not found",
        assemble_fn=assemble_user_plugin_zip,
    )
    _register_entity_git_routes(
        prefix="schema-presets",
        get_fn=schema_preset_service.get,
        repo_getter=git_service.schema_preset_repo_getter,
        read_perm="schemas:read",
        write_perm="schemas:write",
        not_found="Schema preset not found",
        assemble_fn=assemble_schema_preset_zip,
    )


_register_all_entity_git_routes()


# --- Verify + Clone (no entity, just authenticated) -----------------------


@router.post("/verify-remote", response_model=GitVerifyResponse)
async def verify_remote(
    body: GitVerifyRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Check a remote is reachable with the given credentials before the caller
    persists the link — so an unreachable/unauthorized URL is rejected up front
    instead of silently saved and only failing later in the sync panel. On
    success, remember the token for this user + host so the token-less sync ops
    (status/diff/commit-push) can use it afterwards."""
    try:
        result = await git_service.verify_remote(body.url, body.token)
    except git_service.GitError as exc:
        raise _git_http_error(exc) from exc
    if body.token:
        await git_credential_service.set_token_for_url(db, user, body.url, body.token)
    return result


@router.post("/clone")
async def clone(
    body: GitCloneRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Shallow-clone a remote server-side and stream back its content as a ZIP,
    so the import flow works without an in-browser CORS proxy. A token used here
    is remembered for this user + host so later sync ops find it."""
    from fastapi.responses import Response

    try:
        data, cloned_oid = await git_service.clone_to_zip(
            body.url, body.branch or "main", body.token
        )
    except git_service.GitError as exc:
        raise _git_http_error(exc) from exc
    if body.token:
        await git_credential_service.set_token_for_url(db, user, body.url, body.token)
    headers = {"Content-Disposition": 'attachment; filename="repo.zip"'}
    # Expose the cloned HEAD so the import flow can anchor the new entity's sync
    # state to it (see mapping_project_set_sync_state). Custom header must be
    # explicitly exposed for the browser fetch to read it.
    if cloned_oid:
        headers["X-Git-Cloned-Oid"] = cloned_oid
        headers["Access-Control-Expose-Headers"] = "X-Git-Cloned-Oid"
    return Response(content=data, media_type="application/zip", headers=headers)


# --- Per-user host token management ---------------------------------------


@router.put("/host-token", response_model=GitHostTokenStatus)
async def set_host_token(
    body: GitHostTokenRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Store (or clear, when the token is empty) the acting user's access token
    for the host of `url`. The token is encrypted at rest and reused for every
    repo on that host; it is never returned by the API."""
    host = git_credential_service.host_of(body.url)
    if not host:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Could not determine host from URL")
    await git_credential_service.set_token(db, user, host, body.token)
    return {"host": host, "has_token": bool(body.token)}


@router.get("/host-token", response_model=GitHostTokenStatus)
async def get_host_token_status(
    url: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Whether the acting user has a token stored for the host of `url` (the token
    itself is never returned — only its presence)."""
    host = git_credential_service.host_of(url)
    if not host:
        return {"host": None, "has_token": False}
    return {"host": host, "has_token": await git_credential_service.has_token_for_host(db, user, host)}


# --- Settings scope (account-level: organizations + users + roles) --------
#
# Unlike the other scopes this one is not workspace-membership gated — it manages
# accounts, so it requires the global admin. The "entity" is the app_settings
# singleton, addressed as /git/settings/account/... so it slots into the same
# generic client (scope="settings", id="account") that drives the shared
# GitRepositoryTab + GitSyncPanel. The server always BUILDS the full export tree
# (organizations + users + roles); which files to push is chosen in the panel
# (per-file selection / quick actions), like every other scope.

SETTINGS_ID = "settings/account"


async def _settings_remote(db: AsyncSession) -> str | None:
    row = await app_settings_service.get_or_create(db)
    cfg = row.git_remote_config or {}
    return cfg.get("url") or None


async def _settings_branch(db: AsyncSession, fallback: str | None) -> str:
    if fallback:
        return fallback
    row = await app_settings_service.get_or_create(db)
    cfg = row.git_remote_config or {}
    return cfg.get("branch") or "main"


async def _settings_token(db: AsyncSession, user: User) -> str | None:
    return await git_credential_service.token_for_url(db, user, await _settings_remote(db))


@router.get("/settings/account/config", response_model=SettingsGitConfigResponse)
async def settings_git_config(
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    row = await app_settings_service.get_or_create(db)
    cfg = row.git_remote_config or {}
    return {"url": cfg.get("url"), "branch": cfg.get("branch")}


@router.put("/settings/account/config", response_model=SettingsGitConfigResponse)
async def set_settings_git_config(
    body: SettingsGitConfig,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Set the settings-scope git remote. The token (if any) is stripped and stored
    per (user, host); only {url, branch} is persisted and returned."""
    payload = {"url": body.url, "branch": body.branch}
    if body.auth_token:
        payload["authToken"] = body.auth_token
    row, token = await app_settings_service.set_git_remote_config(
        db, payload if body.url else None
    )
    if token and body.url:
        await git_credential_service.set_token_for_url(db, admin, body.url, token)
    cfg = row.git_remote_config or {}
    return {"url": cfg.get("url"), "branch": cfg.get("branch")}


@router.post("/settings/account/status", response_model=GitStatusResponse)
async def settings_status(
    file: UploadFile | None = File(None),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_admin),
):
    remote = await _settings_remote(db)
    result = await _guard(
        git_service.status(
            git_service.settings_repo_getter,
            SETTINGS_ID,
            await assemble_settings_zip(db, SettingsSelection()),
            await _settings_branch(db, branch),
            remote,
            await _settings_token(db, user),
        )
    )
    return {"linked": remote is not None, **result}


@router.post("/settings/account/diff", response_model=GitDiffResponse)
async def settings_diff(
    file: UploadFile | None = File(None),
    path: str = Form(...),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_admin),
):
    return await _guard(
        git_service.diff(
            git_service.settings_repo_getter,
            SETTINGS_ID,
            await assemble_settings_zip(db, SettingsSelection()),
            await _settings_branch(db, branch),
            path,
            await _settings_remote(db),
            await _settings_token(db, user),
        )
    )


@router.get("/settings/account/branches", response_model=GitBranchesResponse)
async def settings_branches(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_admin),
):
    return await git_service.branches(
        git_service.settings_repo_getter,
        SETTINGS_ID,
        await _settings_remote(db),
        await _settings_token(db, user),
    )


@router.get("/settings/account/sync-state", response_model=GitSyncStateResponse)
async def settings_sync_state(
    branch: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_admin),
):
    return await _sync_state(
        db,
        "settings",
        git_service.settings_repo_getter,
        SETTINGS_ID,
        await _settings_branch(db, branch),
        await _settings_remote(db),
        await _settings_token(db, user),
    )


@router.post("/settings/account/commit-push", response_model=GitCommitResponse)
async def settings_commit_push(
    file: UploadFile | None = File(None),
    message: str = Form(...),
    branch: str | None = Form(None),
    paths: list[str] | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_admin),
):
    remote = await _settings_remote(db)
    if remote is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Settings are not linked to a git remote"
        )
    resolved_branch = await _settings_branch(db, branch)
    row = await git_sync_state_service.get(db, "settings", SETTINGS_ID, resolved_branch)
    result = await _guard(
        git_service.commit_push(
            git_service.settings_repo_getter,
            SETTINGS_ID,
            await assemble_settings_zip(db, SettingsSelection()),
            resolved_branch,
            message,
            remote,
            await _settings_token(db, user),
            paths,
            row.synced_oid if row else None,
        )
    )
    if result.get("pushed") and result.get("commit"):
        await git_sync_state_service.set_oid(
            db, "settings", SETTINGS_ID, resolved_branch, result["commit"]["oid"]
        )
    return result


@router.post("/settings/account/set-sync-state", status_code=status.HTTP_204_NO_CONTENT)
async def settings_set_sync_state(
    body: GitSetSyncStateRequest,
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    await git_sync_state_service.set_oid(
        db, "settings", SETTINGS_ID, body.branch, body.synced_oid
    )


def _read_zip_tree(zip_bytes: bytes) -> dict[str, bytes]:
    import io
    import zipfile

    tree: dict[str, bytes] = {}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for name in zf.namelist():
            if name.endswith("/"):
                continue
            tree[name] = zf.read(name)
    return tree


async def _apply_settings_zip(
    db: AsyncSession,
    zip_bytes: bytes,
    acting_username: str | None,
    selection: SettingsSelection | None = None,
) -> SettingsImportResponse:
    import asyncio

    tree = await asyncio.to_thread(_read_zip_tree, zip_bytes)
    if selection is not None:
        tree = _selection_from_tree(tree, selection)
    report = await settings_import_service.import_settings_tree(db, tree, acting_username)
    return SettingsImportResponse(**report.as_dict())


@router.get("/settings/account/export")
async def settings_export_zip(
    _admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Download the settings export as a ZIP (organizations + users + roles, no
    passwords) — the offline/manual counterpart to git push."""
    from fastapi.responses import Response

    data = await assemble_settings_zip(db, SettingsSelection())
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="settings.zip"'},
    )


def _selection_from_tree(tree: dict[str, bytes], sel: SettingsSelection) -> dict[str, bytes]:
    """Keep only the family files the caller opted into (import chooses what to apply)."""
    keep = set()
    if sel.organizations:
        keep.add("organizations.json")
    if sel.users:
        keep.add("users.json")
    if sel.roles:
        keep.add("roles.json")
    return {k: v for k, v in tree.items() if k in keep}


@router.post("/settings/account/import-file", response_model=SettingsImportResponse)
async def settings_import_file(
    file: UploadFile = File(...),
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Upload a settings ZIP (organizations/users/roles) and upsert it. New users
    land disabled (no password). Only the files present in the ZIP are applied."""
    return await _apply_settings_zip(db, await file.read(), admin.username)


async def _clone_settings_tree(db: AsyncSession, admin: User, branch: str | None):
    """Clone the settings remote → (tree, cloned_oid, resolved_branch). Shared by the
    pull preview and the pull apply."""
    remote = await _settings_remote(db)
    if remote is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Settings are not linked to a git remote"
        )
    resolved_branch = await _settings_branch(db, branch)
    try:
        zip_bytes, cloned_oid = await git_service.clone_to_zip(
            remote, resolved_branch, await _settings_token(db, admin)
        )
    except git_service.GitError as exc:
        raise _git_http_error(exc) from exc
    import asyncio
    tree = await asyncio.to_thread(_read_zip_tree, zip_bytes)
    return tree, cloned_oid, resolved_branch


@router.get("/settings/account/pull-preview", response_model=SettingsPullPreview)
async def settings_pull_preview(
    branch: str | None = None,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_current_admin),
):
    """Fetch the remote settings tree and report how many organizations / users /
    roles it contains, so the pull dialog can let the admin choose what to apply."""
    import json

    tree, _oid, _branch = await _clone_settings_tree(db, admin, branch)

    def _count(name: str) -> int | None:
        raw = tree.get(name)
        if raw is None:
            return None
        try:
            data = json.loads(raw.decode("utf-8"))
            return len(data) if isinstance(data, list) else 0
        except (ValueError, UnicodeDecodeError):
            return 0

    return SettingsPullPreview(
        organizations=_count("organizations.json"),
        users=_count("users.json"),
        roles=_count("roles.json"),
    )


@router.post("/settings/account/import-remote", response_model=SettingsImportResponse)
async def settings_import_remote(
    branch: str | None = Form(None),
    include_orgs: bool = Form(True),
    include_users: bool = Form(True),
    include_roles: bool = Form(True),
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_current_admin),
):
    """Pull the settings tree from the configured git remote and upsert the chosen
    families. Anchors the sync state to the fetched head so a later push is diffed
    correctly."""
    tree, cloned_oid, resolved_branch = await _clone_settings_tree(db, admin, branch)
    selection = SettingsSelection(
        organizations=include_orgs, users=include_users, roles=include_roles
    )
    tree = _selection_from_tree(tree, selection)
    report = await settings_import_service.import_settings_tree(db, tree, admin.username)
    if cloned_oid:
        await git_sync_state_service.set_oid(
            db, "settings", SETTINGS_ID, resolved_branch, cloned_oid
        )
    return SettingsImportResponse(**report.as_dict())
