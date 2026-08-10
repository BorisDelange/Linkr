from datetime import datetime

from app.schemas.base import CamelModel


class UserPluginCreate(CamelModel):
    id: str
    entity_id: str | None = None
    workspace_id: str  # required — plugins are always workspace-scoped
    # README + licence ({id, name?, text}); the licence text travels as LICENSE.md
    # in exports. Present on Update too — a field missing there is silently dropped
    # on git/import round-trips.
    readme: dict | str | None = None
    license: dict | None = None
    files: dict = {}
    git_remote_config: dict | None = None
    organization: dict | None = None
    # Author provenance: accepted so an imported plugin keeps its origin author.
    # created_by_id is never trusted (stamp_creator derives the local id).
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    # Creation date preserved on import round-trip; absent → server_default now.
    created_at: datetime | None = None


class UserPluginUpdate(CamelModel):
    entity_id: str | None = None
    readme: dict | str | None = None
    license: dict | None = None
    files: dict | None = None
    git_remote_config: dict | None = None


class UserPluginResponse(CamelModel):
    id: str
    entity_id: str | None = None
    workspace_id: str
    readme: dict | str | None = None
    license: dict | None = None
    files: dict
    git_remote_config: dict | None = None
    organization: dict | None = None
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    created_at: datetime
    updated_at: datetime
