"""Server file-browser routes. The project Folders settings routes are gated on
``project-settings:write`` (choosing which server folder a project binds to is a
project-configuration act, not code execution); the import and workspace routes
answer to the permission of what they feed (see below). The heavy lifting lives in
``services.fs_browser``; validation against the configured browse roots happens
there. Server mode only — front-only has no server filesystem to browse."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_project_permission, check_workspace_permission, require_project_permission
from app.models.project import Project
from app.models.user import User
from app.services import fs_browser, project_fs

router = APIRouter(prefix="/projects/{project_uid}/fs", tags=["fs-browser"])


@router.get("/resolved")
async def resolved_dirs(
    project: Project = Depends(require_project_permission("ide:read")),
):
    """The absolute server dirs the project's IDE working dir, code (scripts), and
    datasets bind to (resolving the default when unset), plus the DEFAULT dirs
    regardless of the current binding (so the folder picker can offer a "reset to
    default" jump). Drives the IDE root hover + the Datasets 'Copy path'. Read-only,
    so gated on ide:read (any project member)."""
    project_fs.prime_binding(project.uid, project.ide_path, project.scripts_path, project.datasets_path)
    root = project_fs.project_dir(project.uid)
    return {
        "ide": str(project_fs.ide_dir(project.uid)),
        "scripts": str(project_fs.scripts_dir(project.uid)),
        "datasets": str(project_fs.datasets_dir(project.uid)),
        # Defaults (binding NULL): ide + scripts → scripts/, datasets → datasets/.
        "defaults": {
            "ide": str(root / "scripts"),
            "scripts": str(root / "scripts"),
            "datasets": str(root / "datasets"),
        },
    }


def _guard() -> None:
    # The browser reaches the real filesystem; refuse entirely when server-side
    # code/FS features are disabled for the deployment.
    if not settings.enable_code_execution:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "File browsing is disabled")


def _split_extensions(raw: str | None) -> list[str] | None:
    """Comma-separated query value → list; a display filter, never a boundary."""
    if not raw:
        return None
    return [p for p in (part.strip() for part in raw.split(",")) if p]


@router.get("/list-dir")
async def list_dir(
    path: str = Query("", description="Absolute server path; empty = a browse root"),
    include_files: bool = Query(False, alias="includeFiles"),
    extensions: str | None = Query(None, description="Comma-separated, e.g. .parquet,.csv"),
    _project: Project = Depends(require_project_permission("project-settings:write")),
    _user: User = Depends(get_current_user),
):
    _guard()
    try:
        return fs_browser.list_dir(path, include_files, _split_extensions(extensions))
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


# --- Project-scoped browsing for an import (dataset / IDE upload from the server)
# Picking a file to COPY into the project answers to the permission of what it
# lands in, not to project-settings:write — a member who may import a dataset need
# not be allowed to re-bind the project's folders. Not behind `_guard()` when browse
# roots confine it; without roots it is gated like code execution (see
# `fs_browser.import_list_dir`).

_IMPORT_PERMISSION = {"datasets": "datasets:write", "ide": "ide:write"}


@router.get("/import/{target}/list-dir")
async def import_list_dir(
    project_uid: str,
    target: Literal["datasets", "ide"],
    path: str = Query("", description="Absolute server path; empty = a browse root"),
    extensions: str | None = Query(None, description="Comma-separated, e.g. .csv,.parquet"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    await check_project_permission(db, project, user, _IMPORT_PERMISSION[target])
    whole_fs = await fs_browser.whole_fs_import_allowed(db, project, user)
    try:
        return fs_browser.import_list_dir(path, _split_extensions(extensions), whole_fs_allowed=whole_fs)
    except fs_browser.FsBrowseError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


# --- Workspace-scoped browsing (databases pointing at server data) -------------
# A database is workspace-scoped, so it cannot ride the project routes above.
# These carry their own workspace + permission rather than widening the project
# ones: browsing the filesystem always answers to *some* explicit authority.
# Deliberately NOT behind `_guard()` — see `fs_browser.validate_source_path`:
# attaching a database read-only is not code execution, and a deployment with the
# IDE turned off must still be able to point Linkr at its own data.

ws_router = APIRouter(prefix="/workspaces/{workspace_id}/fs", tags=["fs-browser"])


@ws_router.get("/list-dir")
async def ws_list_dir(
    workspace_id: str,
    path: str = Query("", description="Absolute server path; empty = a browse root"),
    include_files: bool = Query(False, alias="includeFiles"),
    extensions: str | None = Query(None, description="Comma-separated, e.g. .parquet,.csv"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, workspace_id, user, "databases:write")
    try:
        return fs_browser.list_dir(path, include_files, _split_extensions(extensions))
    except fs_browser.FsBrowseError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc


class ValidatePathBody(BaseModel):
    path: str
    extensions: list[str] | None = None
    # A Parquet source is a folder, a DuckDB/SQLite source is a file; "new-file"
    # is where a database created from a schema will be written.
    expect: str = "file"


@ws_router.post("/validate-path")
async def ws_validate_path(
    workspace_id: str,
    body: ValidatePathBody,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, workspace_id, user, "databases:write")
    if body.expect == "dir":
        # Not `validate_dir`: that one demands a WRITABLE folder (it validates a
        # project binding the IDE writes into). A Parquet source is only ever read.
        return fs_browser.validate_readable_dir(body.path)
    if body.expect == "writable-dir":
        return fs_browser.validate_dir(body.path)
    if body.expect == "new-file":
        return fs_browser.check_new_database_file(body.path)
    return fs_browser.validate_file(body.path, body.extensions)
