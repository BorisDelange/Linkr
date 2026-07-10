from datetime import datetime

from app.schemas.base import CamelModel


class UserPluginCreate(CamelModel):
    id: str
    entity_id: str | None = None
    workspace_id: str  # required — plugins are always workspace-scoped
    files: dict = {}


class UserPluginUpdate(CamelModel):
    entity_id: str | None = None
    files: dict | None = None


class UserPluginResponse(CamelModel):
    id: str
    entity_id: str | None = None
    workspace_id: str
    files: dict
    created_at: datetime
    updated_at: datetime
