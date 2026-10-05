"""IDE script files — the disk under projects/<uid>/scripts/ is the single
source of truth. The tree is scanned from disk on every read, so files added by
any means (terminal, git) appear in the IDE. No DB table backs these files."""

import asyncio
import mimetypes
import shutil

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_project_permission
from app.models.project import Project
from app.models.user import User
from app.schemas.ide_file import (
    IdeFileCopyFromServer,
    IdeFileCreate,
    IdeFileDelete,
    IdeFileMove,
    IdeFileResponse,
    IdeFileWrite,
)
from app.services import fs_browser, notification_service, project_fs

router = APIRouter(prefix="/ide-files", tags=["ide-files"])


async def _notify(db: AsyncSession, request: Request, user: User, action: str, project_uid: str, path: str) -> None:
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request), action=action,
        entity_type="script", entity_id=path, project_uid=project_uid, label=path,
    )


async def _check_project(db: AsyncSession, project_uid: str, user: User, permission: str) -> None:
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    # ide is a project-tier resource → resolve via the project (honours per-
    # project overrides), not just the raw workspace role.
    await check_project_permission(db, project, user, permission)
    # Cache the path bindings so the sync scan/dir helpers resolve ide_path.
    project_fs.prime_binding(project_uid, project.ide_path, project.scripts_path, project.datasets_path)


def _node(project_uid: str, n: dict, with_content: bool) -> IdeFileResponse:
    content = None
    if with_content and n["type"] == "file":
        content = project_fs.read_script(project_uid, n["path"])
    return IdeFileResponse(
        id=n["id"], name=n["name"], type=n["type"], parent_id=n["parentId"],
        path=n["path"], language=n["language"], order=n["order"], content=content,
    )


def _scan_with_content(project_uid: str) -> list[IdeFileResponse]:
    return [_node(project_uid, n, with_content=True) for n in project_fs.scan_scripts(project_uid)]


@router.get("", response_model=list[IdeFileResponse])
async def list_files(
    project_uid: str = Query(alias="projectUid"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Scan scripts/ from disk and return the tree with each file's content."""
    await _check_project(db, project_uid, user, "ide:read")
    # Off the event loop: this walks the whole IDE working dir and reads EVERY file's
    # content. Run inline it froze the single worker for the duration — the kernels and
    # jobs polls piled up behind it and released in a burst, which reads as the IDE
    # stuttering. A bound ide_path can point at a large folder, so this is unbounded.
    return await asyncio.to_thread(_scan_with_content, project_uid)


@router.get("/raw")
async def read_raw(
    project_uid: str = Query(alias="projectUid"),
    path: str = Query(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The file's bytes as-is: the tree scan carries text only, so an image (or any
    binary file) is read through here."""
    await _check_project(db, project_uid, user, "ide:read")
    try:
        p = project_fs.script_path(project_uid, path)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    if not p.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    media_type = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    return FileResponse(p, media_type=media_type)


@router.post("", response_model=IdeFileResponse, status_code=status.HTTP_201_CREATED)
async def create_file(
    body: IdeFileCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _check_project(db, body.project_uid, user, "ide:write")
    try:
        if body.type == "folder":
            project_fs.make_folder(body.project_uid, body.path)
        else:
            project_fs.write_script(body.project_uid, body.path, body.content or "")
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    await _notify(db, request, user, "created", body.project_uid, body.path)
    return IdeFileResponse(
        id=project_fs.node_id("ide", body.path),
        name=body.path.rsplit("/", 1)[-1],
        type=body.type,
        parent_id=(project_fs.node_id("ide", body.path.rsplit("/", 1)[0]) if "/" in body.path else None),
        path=body.path,
        language=None if body.type == "folder" else project_fs.language_for(body.path),
        order=0,
        content=None if body.type == "folder" else (body.content or ""),
    )


@router.post("/copy-from-server", response_model=IdeFileResponse, status_code=status.HTTP_201_CREATED)
async def copy_from_server(
    body: IdeFileCopyFromServer,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Upload's server-side counterpart: copy a file picked on the server into the
    IDE tree. Bytes are copied as-is, so a binary file (an image, a workbook)
    arrives intact — unlike the text body the browser upload sends."""
    await _check_project(db, body.project_uid, user, "ide:write")
    try:
        src = fs_browser.validate_import_source(body.server_path)
        dst = project_fs.script_path(body.project_uid, body.path)
    except (fs_browser.FsBrowseError, ValueError) as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    if dst.is_dir():
        raise HTTPException(status.HTTP_409_CONFLICT, "A folder already has this name")
    dst.parent.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(shutil.copyfile, src, dst)
    await _notify(db, request, user, "created", body.project_uid, body.path)
    return IdeFileResponse(
        id=project_fs.node_id("ide", body.path),
        name=body.path.rsplit("/", 1)[-1],
        type="file",
        parent_id=(project_fs.node_id("ide", body.path.rsplit("/", 1)[0]) if "/" in body.path else None),
        path=body.path,
        language=project_fs.language_for(body.path),
        order=0,
    )


@router.put("/content", status_code=status.HTTP_204_NO_CONTENT)
async def save_content(
    body: IdeFileWrite,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _check_project(db, body.project_uid, user, "ide:write")
    try:
        project_fs.write_script(body.project_uid, body.path, body.content)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    await _notify(db, request, user, "updated", body.project_uid, body.path)


@router.post("/move", status_code=status.HTTP_204_NO_CONTENT)
async def move_file(
    body: IdeFileMove,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _check_project(db, body.project_uid, user, "ide:write")
    try:
        project_fs.move_script(body.project_uid, body.path, body.new_path)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    await _notify(db, request, user, "updated", body.project_uid, body.new_path)


@router.post("/delete", status_code=status.HTTP_204_NO_CONTENT)
async def delete_file(
    body: IdeFileDelete,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _check_project(db, body.project_uid, user, "ide:delete")
    try:
        project_fs.delete_script(body.project_uid, body.path)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    await _notify(db, request, user, "deleted", body.project_uid, body.path)
