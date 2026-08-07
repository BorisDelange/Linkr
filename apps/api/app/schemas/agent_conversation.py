from datetime import datetime

from app.schemas.base import CamelModel


class AgentConversationCreate(CamelModel):
    workspace_id: str
    project_uid: str | None = None
    surface: str = "dashboard"
    entity_id: str | None = None
    title: str = ""
    messages: list[dict] = []


class AgentConversationUpdate(CamelModel):
    title: str | None = None
    messages: list[dict] | None = None


class AgentConversationSummary(CamelModel):
    """List view: no messages, so opening the history doesn't ship every past
    prompt (which may carry clinical context) to the browser."""

    id: str
    workspace_id: str
    project_uid: str | None
    surface: str
    entity_id: str | None
    title: str
    message_count: int
    created_at: datetime
    updated_at: datetime


class AgentConversationResponse(AgentConversationSummary):
    messages: list[dict]
