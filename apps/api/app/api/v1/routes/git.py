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
