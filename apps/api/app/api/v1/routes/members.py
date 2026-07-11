"""Membership management: who has which role on a workspace or a project.

Workspace members carry the base role (viewer/editor/owner). Project members are
optional per-project overrides that replace the inherited workspace role for that
user (see permissions.effective_project_role). Managing members requires owner on
the target (global admins bypass)."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import (
    check_project_role,
    check_workspace_role,
    effective_project_role,
    effective_workspace_role,
)
from app.models.project import Project
from app.models.user import User
from app.models.workspace_member import WorkspaceMember
from app.schemas.member import (
    MemberUser,
    MyRoleResponse,
    ProjectMemberResponse,
    ProjectMemberWrite,
    WorkspaceMemberResponse,
    WorkspaceMemberWrite,
)
from app.services import member_service

router = APIRouter(tags=["members"])


def _validate_role(role: str, *, allow_none: bool = False) -> None:
    valid = member_service.VALID_ROLES + (("none",) if allow_none else ())
    if role not in valid:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"role must be one of {valid}",
        )


async def _resolve_user_id(
    db: AsyncSession, user_id: int | None, username: str | None
) -> int:
    """Turn an id-or-username membership target into a concrete user id."""
    if user_id is not None:
        if await db.get(User, user_id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
        return user_id
    if username:
        found = await db.scalar(select(User).where(User.username == username))
        if found is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
        return found.id
    raise HTTPException(
        status.HTTP_422_UNPROCESSABLE_ENTITY, "userId or username is required"
    )


# --- "My role" (current user's effective role, for UI gating) --------------


@router.get("/workspaces/{workspace_id}/my-role", response_model=MyRoleResponse)
async def my_workspace_role(
    workspace_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The current user's effective role on this workspace (admin → owner,
    widened by any global all-workspaces grant)."""
    return MyRoleResponse(role=await effective_workspace_role(db, workspace_id, user))


@router.get("/projects/{project_uid}/my-role", response_model=MyRoleResponse)
async def my_project_role(
    project_uid: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The current user's effective role on this project (override > inherited)."""
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    return MyRoleResponse(role=await effective_project_role(db, project, user))


# --- Workspace members ----------------------------------------------------


@router.get(
    "/workspaces/{workspace_id}/members",
    response_model=list[WorkspaceMemberResponse],
)
async def list_workspace_members(
    workspace_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_role(db, workspace_id, user, "viewer")
    rows = await member_service.list_workspace_members(db, workspace_id)
    return [
        WorkspaceMemberResponse(
            workspace_id=m.workspace_id,
            user_id=m.user_id,
            role=m.role,
            created_at=m.created_at,
            user=MemberUser(id=u.id, username=u.username, email=u.email),
        )
        for m, u in rows
    ]


@router.put(
    "/workspaces/{workspace_id}/members",
    response_model=WorkspaceMemberResponse,
)
async def upsert_workspace_member(
    workspace_id: str,
    body: WorkspaceMemberWrite,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Add a member or change their role. Requires owner on the workspace."""
    await check_workspace_role(db, workspace_id, user, "owner")
    _validate_role(body.role)
    target_id = await _resolve_user_id(db, body.user_id, body.username)
    member = await member_service.upsert_workspace_member(
        db, workspace_id, target_id, body.role
    )
    return WorkspaceMemberResponse(
        workspace_id=member.workspace_id,
        user_id=member.user_id,
        role=member.role,
        created_at=member.created_at,
    )


@router.delete(
    "/workspaces/{workspace_id}/members/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_workspace_member(
    workspace_id: str,
    user_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove a member. Requires owner. Refuses to drop the last owner so a
    workspace can never be left with nobody able to manage it."""
    await check_workspace_role(db, workspace_id, user, "owner")
    target = await db.get(WorkspaceMember, (workspace_id, user_id))
    if target is not None and target.role == "owner":
        if await member_service.count_workspace_owners(db, workspace_id) <= 1:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Cannot remove the last owner of the workspace",
            )
    await member_service.remove_workspace_member(db, workspace_id, user_id)


# --- Project members (overrides) ------------------------------------------


async def _load_project(db: AsyncSession, project_uid: str) -> Project:
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    return project


@router.get(
    "/projects/{project_uid}/members",
    response_model=list[ProjectMemberResponse],
)
async def list_project_members(
    project_uid: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await _load_project(db, project_uid)
    await check_project_role(db, project, user, "viewer")
    rows = await member_service.list_project_members(db, project_uid)
    return [
        ProjectMemberResponse(
            project_uid=m.project_uid,
            user_id=m.user_id,
            role=m.role,
            created_at=m.created_at,
            user=MemberUser(id=u.id, username=u.username, email=u.email),
        )
        for m, u in rows
    ]


@router.put(
    "/projects/{project_uid}/members",
    response_model=ProjectMemberResponse,
)
async def upsert_project_member(
    project_uid: str,
    body: ProjectMemberWrite,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Set a per-project role override for a user. Requires owner on the project.
    Role "none" hides the project from that user even if they're a workspace member."""
    project = await _load_project(db, project_uid)
    await check_project_role(db, project, user, "owner")
    _validate_role(body.role, allow_none=True)
    target_id = await _resolve_user_id(db, body.user_id, body.username)
    member = await member_service.upsert_project_member(
        db, project_uid, target_id, body.role
    )
    return ProjectMemberResponse(
        project_uid=member.project_uid,
        user_id=member.user_id,
        role=member.role,
        created_at=member.created_at,
    )


@router.delete(
    "/projects/{project_uid}/members/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_project_member(
    project_uid: str,
    user_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Drop the override (the user falls back to their inherited workspace role).
    Requires owner on the project."""
    project = await _load_project(db, project_uid)
    await check_project_role(db, project, user, "owner")
    await member_service.remove_project_member(db, project_uid, user_id)
