"""Server file-browser routes for the project Folders settings. Every route is
gated on ``project-settings:write`` (choosing which server folder a project binds
to is a project-configuration act, not code execution). The heavy lifting lives in
``services.fs_browser``; validation against the configured browse roots happens
there. Server mode only — front-only has no server filesystem to browse."""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.config import settings
from app.core.deps import get_current_user
from app.core.permissions import require_project_permission
from app.models.project import Project
from app.models.user import User
from app.services import fs_browser, project_fs

router = APIRouter(prefix="/projects/{project_uid}/fs", tags=["fs-browser"])


@router.get("/resolved")
async def resolved_dirs(
    project: Project = Depends(require_project_permission("ide:read")),
):
    """The absolute server dirs the project's IDE working dir, code (scripts), and
    datasets bind to (resolving the default when unset). Drives the IDE root hover +
    the Datasets 'Copy path'. Read-only, so gated on ide:read (any project member)."""
    project_fs.prime_binding(project.uid, project.ide_path, project.scripts_path, project.datasets_path)
    return {
        "ide": str(project_fs.ide_dir(project.uid)),
        "scripts": str(project_fs.scripts_dir(project.uid)),
        "datasets": str(project_fs.datasets_dir(project.uid)),
    }


def _guard() -> None:
    # The browser reaches the real filesystem; refuse entirely when server-side
    # code/FS features are disabled for the deployment.
    if not settings.enable_code_execution:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "File browsing is disabled")


@router.get("/list-dir")
async def list_dir(
    path: str = Query("", description="Absolute server path; empty = a browse root"),
    _project: Project = Depends(require_project_permission("project-settings:write")),
    _user: User = Depends(get_current_user),
):
    _guard()
    try:
        return fs_browser.list_dir(path)
    except fs_browser.FsBrowseError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc


class ValidateBody(BaseModel):
    path: str


@router.post("/validate")
async def validate_dir(
    body: ValidateBody,
    _project: Project = Depends(require_project_permission("project-settings:write")),
    _user: User = Depends(get_current_user),
):
    _guard()
    return fs_browser.validate_dir(body.path)


class RebindCopyBody(BaseModel):
    src: str
    dst: str
    on_conflict: str = "keep_both"


@router.post("/rebind-copy")
async def rebind_copy(
    body: RebindCopyBody,
    _project: Project = Depends(require_project_permission("project-settings:write")),
    _user: User = Depends(get_current_user),
):
    """Copy the old folder's files into the newly-bound folder (offered on re-bind).
    The binding change itself is a normal project update; this only moves bytes."""
    _guard()
    try:
        return fs_browser.copy_tree(body.src, body.dst, body.on_conflict)
    except fs_browser.FsBrowseError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
