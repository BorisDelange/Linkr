from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
from app.models.agent_conversation import AgentConversation
from app.models.user import User
from app.schemas.agent_conversation import (
    AgentConversationCreate,
    AgentConversationResponse,
    AgentConversationSummary,
    AgentConversationUpdate,
)

router = APIRouter(tags=["llm"])

_BASE = "/agent-conversations"


def _summary(row: AgentConversation) -> dict:
    return {
        "id": row.id,
        "workspaceId": row.workspace_id,
        "projectUid": row.project_uid,
        "surface": row.surface,
        "entityId": row.entity_id,
        "title": row.title,
        "messageCount": len(row.messages or []),
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
    }


async def _own(db: AsyncSession, conversation_id: str, user: User) -> AgentConversation:
    """Load a conversation belonging to `user`.

    The ownership predicate is part of the query, not a check on the loaded row:
    a conversation owned by someone else is simply not found, so there is no path
    where a mistake downstream could return another user's prompts. Answering 404
    rather than 403 also avoids confirming that a given id exists.
    """
    row = await db.scalar(
        select(AgentConversation).where(
            AgentConversation.id == conversation_id,
            AgentConversation.user_id == user.id,
        )
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return row


@router.get(_BASE, response_model=list[AgentConversationSummary])
async def list_conversations(
    workspace_id: str = Query(alias="workspaceId"),
    project_uid: str | None = Query(default=None, alias="projectUid"),
    surface: str | None = Query(default=None),
    entity_id: str | None = Query(default=None, alias="entityId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The current user's own threads. There is deliberately no way to list
    someone else's, for any role — an admin who needs them has database access."""
    await check_workspace_permission(db, workspace_id, user, "dashboards:read")
    stmt = select(AgentConversation).where(
        AgentConversation.workspace_id == workspace_id,
        AgentConversation.user_id == user.id,
    )
    if project_uid:
        stmt = stmt.where(AgentConversation.project_uid == project_uid)
    if surface:
        stmt = stmt.where(AgentConversation.surface == surface)
    if entity_id:
        stmt = stmt.where(AgentConversation.entity_id == entity_id)
    rows = (await db.scalars(stmt.order_by(AgentConversation.updated_at.desc()))).all()
    return [_summary(row) for row in rows]


@router.get(_BASE + "/{conversation_id}", response_model=AgentConversationResponse)
async def get_conversation(
    conversation_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _own(db, conversation_id, user)
    return {**_summary(row), "messages": row.messages or []}


@router.post(_BASE, response_model=AgentConversationResponse, status_code=status.HTTP_201_CREATED)
async def create_conversation(
    payload: AgentConversationCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, payload.workspace_id, user, "dashboards:read")
    # user_id comes from the token, never from the payload: a client must not be
    # able to file a conversation under someone else's name.
    row = AgentConversation(**payload.model_dump(), user_id=user.id)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return {**_summary(row), "messages": row.messages or []}


@router.patch(_BASE + "/{conversation_id}", response_model=AgentConversationResponse)
async def update_conversation(
    conversation_id: str,
    payload: AgentConversationUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _own(db, conversation_id, user)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    await db.commit()
    await db.refresh(row)
    return {**_summary(row), "messages": row.messages or []}


@router.delete(_BASE + "/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_conversation(
    conversation_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _own(db, conversation_id, user)
    await db.delete(row)
    await db.commit()


@router.delete(_BASE, status_code=status.HTTP_204_NO_CONTENT)
async def clear_conversations(
    workspace_id: str = Query(alias="workspaceId"),
    project_uid: str | None = Query(default=None, alias="projectUid"),
    surface: str | None = Query(default=None),
    entity_id: str | None = Query(default=None, alias="entityId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Clear all — scoped to the caller's own threads, so one user emptying their
    history can never touch another's."""
    stmt = delete(AgentConversation).where(
        AgentConversation.workspace_id == workspace_id,
        AgentConversation.user_id == user.id,
    )
    if project_uid:
        stmt = stmt.where(AgentConversation.project_uid == project_uid)
    if surface:
        stmt = stmt.where(AgentConversation.surface == surface)
    if entity_id:
        stmt = stmt.where(AgentConversation.entity_id == entity_id)
    await db.execute(stmt)
    await db.commit()
