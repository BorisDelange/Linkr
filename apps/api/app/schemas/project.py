from datetime import datetime

from app.schemas.base import CamelModel


class ProjectCreate(CamelModel):
    uid: str | None = None  # client supplies crypto.randomUUID()
    project_id: str | None = None
    workspace_id: str | None = None
    name: dict[str, str]
    description: dict[str, str] = {}
    short_description: dict[str, str] = {}
    config: dict = {}
    git_remote_config: dict | None = None
    status: str | None = None
    badges: list[dict] | None = None
    todos: list[dict] | None = None
    # LocalizedString; accept a bare string too for legacy data / round-trips.
    notes: dict | str | None = None
    readme: dict | str | None = None
    linked_data_source_ids: list[str] | None = None
    organization: dict | None = None
    catalog_visibility: str | None = None
    origin: str = "user"
    # Preserved on import (round-trip); for fresh creates the server stamps the
    # current user, so these are optional here.
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None


class ProjectUpdate(CamelModel):
    project_id: str | None = None
    workspace_id: str | None = None
    name: dict[str, str] | None = None
    description: dict[str, str] | None = None
    short_description: dict[str, str] | None = None
    config: dict | None = None
    git_remote_config: dict | None = None
    status: str | None = None
    badges: list[dict] | None = None
    todos: list[dict] | None = None
    notes: dict | str | None = None
    readme: dict | str | None = None
    linked_data_source_ids: list[str] | None = None
    organization: dict | None = None
    catalog_visibility: str | None = None


class ProjectResponse(CamelModel):
    uid: str
    project_id: str | None = None
    workspace_id: str | None = None
    name: dict[str, str]
    description: dict[str, str]
    short_description: dict[str, str]
    config: dict
    git_remote_config: dict | None = None
    status: str | None = None
    badges: list[dict] | None = None
    todos: list[dict] | None = None
    notes: dict | str | None = None
    readme: dict | str | None = None
    linked_data_source_ids: list[str] | None = None
    organization: dict | None = None
    catalog_visibility: str | None = None
    origin: str
    owner_id: int | None = None
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    created_at: datetime
    updated_at: datetime
