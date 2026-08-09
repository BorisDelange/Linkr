import json
from datetime import datetime

from pydantic import Field, field_validator

from app.schemas.base import CamelModel

# A stored conversation is unbounded user content in a JSON column; without a cap
# it is a trivial way to fill the database. A generous ceiling: a very long
# assistant session, not a payload.
_MAX_MESSAGES = 1000
_MAX_MESSAGES_BYTES = 2 * 1024 * 1024
_MAX_TITLE = 500


def _validate_messages(value: list[dict] | None) -> list[dict] | None:
    if value is None:
        return value
    if len(value) > _MAX_MESSAGES:
        raise ValueError(f"too many messages (max {_MAX_MESSAGES})")
    if len(json.dumps(value).encode("utf-8")) > _MAX_MESSAGES_BYTES:
        raise ValueError("conversation payload is too large")
    return value


class AgentConversationCreate(CamelModel):
    workspace_id: str
    project_uid: str | None = None
    surface: str = "dashboard"
    entity_id: str | None = None
    title: str = Field(default="", max_length=_MAX_TITLE)
    messages: list[dict] = []

    _check_messages = field_validator("messages")(staticmethod(_validate_messages))


class AgentConversationUpdate(CamelModel):
    title: str | None = Field(default=None, max_length=_MAX_TITLE)
    messages: list[dict] | None = None

    _check_messages = field_validator("messages")(staticmethod(_validate_messages))


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
