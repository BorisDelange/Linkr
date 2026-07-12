from datetime import datetime

from app.schemas.base import CamelModel


class UserPluginCreate(CamelModel):
    id: str
    entity_id: str | None = None
    workspace_id: str  # required — plugins are always workspace-scoped
    files: dict = {}
    git_remote_config: dict | None = None


class UserPluginUpdate(CamelModel):
    entity_id: str | None = None
    files: dict | None = None
    git_remote_config: dict | None = None


class UserPluginResponse(CamelModel):
    id: str
    entity_id: str | None = None
    workspace_id: str
    files: dict
    git_remote_config: dict | None = None
    created_at: datetime
    updated_at: datetime
