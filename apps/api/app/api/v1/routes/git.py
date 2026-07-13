"""Server-side git versioning endpoints (push-only) for projects & workspaces.

The frontend owns the DB→files export logic, so it uploads the export ZIP; this
router unpacks it into the entity's git working tree and runs the requested git
operation (status / diff / commit+push / branch list). Clone is used by the
import flow to pull a remote in server mode (no in-browser CORS proxy needed).

Read ops (status/diff/branches) require viewer; write ops (commit/push) require
editor. Access tokens are decrypted server-side from the entity's
git_remote_secret and never leave the server.
"""

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import require_project_permission, require_permission
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.git import (
    GitBranchesResponse,
    GitCloneRequest,
    GitCommitResponse,
    GitDiffResponse,
    GitStatusResponse,
    GitVerifyRequest,
    GitVerifyResponse,
)
from app.services import git_secret, git_service, workspace_service

router = APIRouter(prefix="/git", tags=["git"])


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


def _default_branch(entity, fallback: str | None) -> str:
    if fallback:
        return fallback
    cfg = getattr(entity, "git_remote_config", None) or {}
    return cfg.get("branch") or "main"


# --- Project scope --------------------------------------------------------


@router.post("/projects/{project_uid}/status", response_model=GitStatusResponse)
async def project_status(
    file: UploadFile = File(...),
    branch: str | None = Form(None),
    project=Depends(require_project_permission("project-settings:read")),
):
    result = await _guard(git_service.status(
        git_service.project_repo_getter,
        project.uid,
        await file.read(),
        _default_branch(project, branch),
        _remote_url(project),
        git_secret.token_for(project),
    ))
    return {"linked": _remote_url(project) is not None, **result}


@router.post("/projects/{project_uid}/diff", response_model=GitDiffResponse)
async def project_diff(
    file: UploadFile = File(...),
    path: str = Form(...),
    branch: str | None = Form(None),
    project=Depends(require_project_permission("project-settings:read")),
):
    return await _guard(git_service.diff(
        git_service.project_repo_getter,
        project.uid,
        await file.read(),
        _default_branch(project, branch),
        path,
        _remote_url(project),
        git_secret.token_for(project),
    ))


@router.get("/projects/{project_uid}/branches", response_model=GitBranchesResponse)
async def project_branches(project=Depends(require_project_permission("project-settings:read"))):
    return await git_service.branches(
        git_service.project_repo_getter,
        project.uid,
        _remote_url(project),
        git_secret.token_for(project),
    )


@router.post("/projects/{project_uid}/commit-push", response_model=GitCommitResponse)
async def project_commit_push(
    file: UploadFile = File(...),
    message: str = Form(...),
    branch: str | None = Form(None),
    paths: list[str] | None = Form(None),
    project=Depends(require_project_permission("project-settings:write")),
):
    if _remote_url(project) is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Project is not linked to a git remote")
    return await _guard(git_service.commit_push(
        git_service.project_repo_getter,
        project.uid,
        await file.read(),
        _default_branch(project, branch),
        message,
        _remote_url(project),
        git_secret.token_for(project),
        paths,
    ))


# --- Workspace scope ------------------------------------------------------


async def _load_workspace(workspace_id: str, db: AsyncSession, _member) -> Workspace:
    ws = await workspace_service.get(db, workspace_id)
    if ws is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")
    return ws


@router.post("/workspaces/{workspace_id}/status", response_model=GitStatusResponse)
async def workspace_status(
    workspace_id: str,
    file: UploadFile = File(...),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    _member=Depends(require_permission("workspace-settings:read")),
):
    ws = await _load_workspace(workspace_id, db, _member)
    result = await _guard(git_service.status(
        git_service.workspace_repo_getter,
        ws.id,
        await file.read(),
        _default_branch(ws, branch),
        _remote_url(ws),
        git_secret.token_for(ws),
    ))
    return {"linked": _remote_url(ws) is not None, **result}


@router.post("/workspaces/{workspace_id}/diff", response_model=GitDiffResponse)
async def workspace_diff(
    workspace_id: str,
    file: UploadFile = File(...),
    path: str = Form(...),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    _member=Depends(require_permission("workspace-settings:read")),
):
    ws = await _load_workspace(workspace_id, db, _member)
    return await _guard(git_service.diff(
        git_service.workspace_repo_getter,
        ws.id,
        await file.read(),
        _default_branch(ws, branch),
        path,
        _remote_url(ws),
        git_secret.token_for(ws),
    ))


@router.get("/workspaces/{workspace_id}/branches", response_model=GitBranchesResponse)
async def workspace_branches(
    workspace_id: str,
    db: AsyncSession = Depends(get_db),
    _member=Depends(require_permission("workspace-settings:read")),
):
    ws = await _load_workspace(workspace_id, db, _member)
    return await git_service.branches(
        git_service.workspace_repo_getter, ws.id, _remote_url(ws), git_secret.token_for(ws)
    )


@router.post("/workspaces/{workspace_id}/commit-push", response_model=GitCommitResponse)
async def workspace_commit_push(
    workspace_id: str,
    file: UploadFile = File(...),
    message: str = Form(...),
    branch: str | None = Form(None),
    paths: list[str] | None = Form(None),
    db: AsyncSession = Depends(get_db),
    _member=Depends(require_permission("workspace-settings:write")),
):
    ws = await _load_workspace(workspace_id, db, _member)
    if _remote_url(ws) is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Workspace is not linked to a git remote")
    return await _guard(git_service.commit_push(
        git_service.workspace_repo_getter,
        ws.id,
        await file.read(),
        _default_branch(ws, branch),
        message,
        _remote_url(ws),
        git_secret.token_for(ws),
        paths,
    ))


# --- Mapping project scope ------------------------------------------------


async def _load_mapping_project(mapping_project_id: str, db: AsyncSession, user: User, permission: str):
    from app.core.permissions import check_workspace_permission
    from app.services import mapping_project_service

    mp = await mapping_project_service.get(db, mapping_project_id)
    if mp is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Mapping project not found")
    await check_workspace_permission(db, mp.workspace_id, user, permission)
    return mp


@router.post("/mapping-projects/{mapping_project_id}/status", response_model=GitStatusResponse)
async def mapping_project_status(
    mapping_project_id: str,
    file: UploadFile = File(...),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    mp = await _load_mapping_project(mapping_project_id, db, user, "concept-mapping:read")
    result = await _guard(git_service.status(
        git_service.mapping_project_repo_getter,
        mp.id,
        await file.read(),
        _default_branch(mp, branch),
        _remote_url(mp),
        git_secret.token_for(mp),
    ))
    return {"linked": _remote_url(mp) is not None, **result}


@router.post("/mapping-projects/{mapping_project_id}/diff", response_model=GitDiffResponse)
async def mapping_project_diff(
    mapping_project_id: str,
    file: UploadFile = File(...),
    path: str = Form(...),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    mp = await _load_mapping_project(mapping_project_id, db, user, "concept-mapping:read")
    return await _guard(git_service.diff(
        git_service.mapping_project_repo_getter,
        mp.id,
        await file.read(),
        _default_branch(mp, branch),
        path,
        _remote_url(mp),
        git_secret.token_for(mp),
    ))


@router.get("/mapping-projects/{mapping_project_id}/branches", response_model=GitBranchesResponse)
async def mapping_project_branches(
    mapping_project_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    mp = await _load_mapping_project(mapping_project_id, db, user, "concept-mapping:read")
    return await git_service.branches(
        git_service.mapping_project_repo_getter, mp.id, _remote_url(mp), git_secret.token_for(mp)
    )


@router.post("/mapping-projects/{mapping_project_id}/commit-push", response_model=GitCommitResponse)
async def mapping_project_commit_push(
    mapping_project_id: str,
    file: UploadFile = File(...),
    message: str = Form(...),
    branch: str | None = Form(None),
    paths: list[str] | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    mp = await _load_mapping_project(mapping_project_id, db, user, "concept-mapping:write")
    if _remote_url(mp) is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Mapping project is not linked to a git remote")
    return await _guard(git_service.commit_push(
        git_service.mapping_project_repo_getter,
        mp.id,
        await file.read(),
        _default_branch(mp, branch),
        message,
        _remote_url(mp),
        git_secret.token_for(mp),
        paths,
    ))


# --- SQL script collection scope ------------------------------------------


async def _load_sql_collection(collection_id: str, db: AsyncSession, user: User, permission: str):
    from app.core.permissions import check_workspace_permission
    from app.services import sql_script_service

    collection = await sql_script_service.get(db, collection_id)
    if collection is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "SQL script collection not found")
    await check_workspace_permission(db, collection.workspace_id, user, permission)
    return collection


@router.post("/sql-script-collections/{collection_id}/status", response_model=GitStatusResponse)
async def sql_collection_status(
    collection_id: str,
    file: UploadFile = File(...),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = await _load_sql_collection(collection_id, db, user, "sql-scripts:read")
    result = await _guard(git_service.status(
        git_service.sql_collection_repo_getter,
        c.id,
        await file.read(),
        _default_branch(c, branch),
        _remote_url(c),
        git_secret.token_for(c),
    ))
    return {"linked": _remote_url(c) is not None, **result}


@router.post("/sql-script-collections/{collection_id}/diff", response_model=GitDiffResponse)
async def sql_collection_diff(
    collection_id: str,
    file: UploadFile = File(...),
    path: str = Form(...),
    branch: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = await _load_sql_collection(collection_id, db, user, "sql-scripts:read")
    return await _guard(git_service.diff(
        git_service.sql_collection_repo_getter,
        c.id,
        await file.read(),
        _default_branch(c, branch),
        path,
        _remote_url(c),
        git_secret.token_for(c),
    ))


@router.get("/sql-script-collections/{collection_id}/branches", response_model=GitBranchesResponse)
async def sql_collection_branches(
    collection_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = await _load_sql_collection(collection_id, db, user, "sql-scripts:read")
    return await git_service.branches(
        git_service.sql_collection_repo_getter, c.id, _remote_url(c), git_secret.token_for(c)
    )


@router.post("/sql-script-collections/{collection_id}/commit-push", response_model=GitCommitResponse)
async def sql_collection_commit_push(
    collection_id: str,
    file: UploadFile = File(...),
    message: str = Form(...),
    branch: str | None = Form(None),
    paths: list[str] | None = Form(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    c = await _load_sql_collection(collection_id, db, user, "sql-scripts:write")
    if _remote_url(c) is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "SQL script collection is not linked to a git remote")
    return await _guard(git_service.commit_push(
        git_service.sql_collection_repo_getter,
        c.id,
        await file.read(),
        _default_branch(c, branch),
        message,
        _remote_url(c),
        git_secret.token_for(c),
        paths,
    ))


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
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{not_found} has no workspace")
    await check_workspace_permission(db, entity.workspace_id, user, permission)
    return entity


def _register_entity_git_routes(*, prefix, get_fn, repo_getter, read_perm, write_perm, not_found):
    """Add status/diff/branches/commit-push for a workspace-scoped entity."""

    @router.post(f"/{prefix}/{{entity_id}}/status", response_model=GitStatusResponse, name=f"{prefix}_status")
    async def _status(
        entity_id: str,
        file: UploadFile = File(...),
        branch: str | None = Form(None),
        db: AsyncSession = Depends(get_db),
        user: User = Depends(get_current_user),
    ):
        e = await _load_workspace_entity(get_fn, entity_id, db, user, read_perm, not_found)
        result = await _guard(git_service.status(
            repo_getter, _entity_id(e), await file.read(),
            _default_branch(e, branch), _remote_url(e), git_secret.token_for(e),
        ))
        return {"linked": _remote_url(e) is not None, **result}

    @router.post(f"/{prefix}/{{entity_id}}/diff", response_model=GitDiffResponse, name=f"{prefix}_diff")
    async def _diff(
        entity_id: str,
        file: UploadFile = File(...),
        path: str = Form(...),
        branch: str | None = Form(None),
        db: AsyncSession = Depends(get_db),
        user: User = Depends(get_current_user),
    ):
        e = await _load_workspace_entity(get_fn, entity_id, db, user, read_perm, not_found)
        return await _guard(git_service.diff(
            repo_getter, _entity_id(e), await file.read(),
            _default_branch(e, branch), path, _remote_url(e), git_secret.token_for(e),
        ))

    @router.get(f"/{prefix}/{{entity_id}}/branches", response_model=GitBranchesResponse, name=f"{prefix}_branches")
    async def _branches(
        entity_id: str,
        db: AsyncSession = Depends(get_db),
        user: User = Depends(get_current_user),
    ):
        e = await _load_workspace_entity(get_fn, entity_id, db, user, read_perm, not_found)
        return await git_service.branches(repo_getter, _entity_id(e), _remote_url(e), git_secret.token_for(e))

    @router.post(f"/{prefix}/{{entity_id}}/commit-push", response_model=GitCommitResponse, name=f"{prefix}_commit_push")
    async def _commit_push(
        entity_id: str,
        file: UploadFile = File(...),
        message: str = Form(...),
        branch: str | None = Form(None),
        paths: list[str] | None = Form(None),
        db: AsyncSession = Depends(get_db),
        user: User = Depends(get_current_user),
    ):
        e = await _load_workspace_entity(get_fn, entity_id, db, user, write_perm, not_found)
        if _remote_url(e) is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{not_found} is not linked to a git remote")
        return await _guard(git_service.commit_push(
            repo_getter, _entity_id(e), await file.read(),
            _default_branch(e, branch), message, _remote_url(e), git_secret.token_for(e), paths,
        ))


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

    _register_entity_git_routes(
        prefix="etl-pipelines", get_fn=etl_pipeline_service.get,
        repo_getter=git_service.etl_pipeline_repo_getter,
        read_perm="etl:read", write_perm="etl:write", not_found="ETL pipeline not found",
    )
    _register_entity_git_routes(
        prefix="data-catalogs", get_fn=data_catalog_service.get,
        repo_getter=git_service.data_catalog_repo_getter,
        read_perm="catalog:read", write_perm="catalog:write", not_found="Data catalog not found",
    )
    _register_entity_git_routes(
        prefix="dq-rule-sets", get_fn=dq_rule_set_service.get,
        repo_getter=git_service.dq_rule_set_repo_getter,
        read_perm="data-quality:read", write_perm="data-quality:write", not_found="DQ rule set not found",
    )
    _register_entity_git_routes(
        prefix="user-plugins", get_fn=user_plugin_service.get,
        repo_getter=git_service.user_plugin_repo_getter,
        read_perm="plugins:read", write_perm="plugins:write", not_found="Plugin not found",
    )
    _register_entity_git_routes(
        prefix="schema-presets", get_fn=schema_preset_service.get,
        repo_getter=git_service.schema_preset_repo_getter,
        read_perm="schemas:read", write_perm="schemas:write", not_found="Schema preset not found",
    )


_register_all_entity_git_routes()


# --- Verify + Clone (no entity, just authenticated) -----------------------


@router.post("/verify-remote", response_model=GitVerifyResponse)
async def verify_remote(body: GitVerifyRequest, _user: User = Depends(get_current_user)):
    """Check a remote is reachable with the given credentials before the caller
    persists the link — so an unreachable/unauthorized URL is rejected up front
    instead of silently saved and only failing later in the sync panel."""
    try:
        return await git_service.verify_remote(body.url, body.token)
    except git_service.GitError as exc:
        raise _git_http_error(exc) from exc


@router.post("/clone")
async def clone(body: GitCloneRequest, _user: User = Depends(get_current_user)):
    """Shallow-clone a remote server-side and stream back its content as a ZIP,
    so the import flow works without an in-browser CORS proxy."""
    from fastapi.responses import Response

    try:
        data = await git_service.clone_to_zip(body.url, body.branch or "main", body.token)
    except git_service.GitError as exc:
        raise _git_http_error(exc) from exc
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="repo.zip"'},
    )
