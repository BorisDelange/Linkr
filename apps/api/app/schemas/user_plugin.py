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
    version: str = "0.1.0"
    # Cross-instance identity, preserved verbatim across export/import.
    lineage_id: str | None = None
    parent_lineage_id: str | None = None
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
    version: str | None = None
    # A field missing here is silently dropped on git/import round-trips, which is
    # what kept createdAt drifting on other entities (see createdat-git-roundtrip).
    lineage_id: str | None = None
    parent_lineage_id: str | None = None


class UserPluginResponse(CamelModel):
    id: str
    entity_id: str | None = None
    workspace_id: str
    readme: dict | str | None = None
    license: dict | None = None
    files: dict
    git_remote_config: dict | None = None
    organization: dict | None = None
    version: str = "0.1.0"
    lineage_id: str | None = None
    parent_lineage_id: str | None = None
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    created_at: datetime
    updated_at: datetime
