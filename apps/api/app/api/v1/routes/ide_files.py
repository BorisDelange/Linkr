"""IDE script files — the disk under projects/<uid>/scripts/ is the single
source of truth. The tree is scanned from disk on every read, so files added by
any means (terminal, git) appear in the IDE. No DB table backs these files."""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_project_permission
from app.models.project import Project
from app.models.user import User
from app.schemas.ide_file import (
    IdeFileCreate,
    IdeFileDelete,
    IdeFileMove,
    IdeFileResponse,
    IdeFileWrite,
)
from app.services import project_fs

router = APIRouter(prefix="/ide-files", tags=["ide-files"])


async def _check_project(db: AsyncSession, project_uid: str, user: User, permission: str) -> None:
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    if project.workspace_id is not None:
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


@router.get("", response_model=list[IdeFileResponse])
async def list_files(
    project_uid: str = Query(alias="projectUid"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Scan scripts/ from disk and return the tree with each file's content."""
    await _check_project(db, project_uid, user, "ide:read")
    return [_node(project_uid, n, with_content=True) for n in project_fs.scan_scripts(project_uid)]


@router.post("", response_model=IdeFileResponse, status_code=status.HTTP_201_CREATED)
async def create_file(
    body: IdeFileCreate,
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


@router.put("/content", status_code=status.HTTP_204_NO_CONTENT)
async def save_content(
    body: IdeFileWrite,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _check_project(db, body.project_uid, user, "ide:write")
    try:
        project_fs.write_script(body.project_uid, body.path, body.content)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))


@router.post("/move", status_code=status.HTTP_204_NO_CONTENT)
async def move_file(
    body: IdeFileMove,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _check_project(db, body.project_uid, user, "ide:write")
    try:
        project_fs.move_script(body.project_uid, body.path, body.new_path)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))


@router.post("/delete", status_code=status.HTTP_204_NO_CONTENT)
async def delete_file(
    body: IdeFileDelete,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _check_project(db, body.project_uid, user, "ide:delete")
    try:
        project_fs.delete_script(body.project_uid, body.path)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
