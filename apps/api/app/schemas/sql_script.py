from datetime import datetime

from app.schemas.base import CamelModel


class SqlScriptCollectionCreate(CamelModel):
    id: str
    workspace_id: str
    entity_id: str | None = None
    name: dict = {}
    description: dict = {}
    badges: list | None = None
    # README + licence ({id, name?, text}); the licence text travels as LICENSE.md
    # in exports. Present on Update too — a field missing there is silently dropped
    # on git/import round-trips.
    readme: dict | str | None = None
    license: dict | None = None
    default_data_source_id: str | None = None
    git_remote_config: dict | None = None
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    organization: dict | None = None
    lineage_id: str | None = None
    parent_lineage_id: str | None = None
    # Creation date preserved on import round-trip; absent → server_default now.
    created_at: datetime | None = None
    version: str = "0.1.0"


class SqlScriptCollectionUpdate(CamelModel):
    entity_id: str | None = None
    name: dict | None = None
    description: dict | None = None
    badges: list | None = None
    readme: dict | str | None = None
    license: dict | None = None
    default_data_source_id: str | None = None
    git_remote_config: dict | None = None
    # Editable authoring provenance (author re-attribution + org snapshot).
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    organization: dict | None = None
    lineage_id: str | None = None
    parent_lineage_id: str | None = None
    version: str | None = None
    # Restored on import/clone so the original creation date survives a git
    # round-trip; a normal PATCH never sends it (exclude_unset leaves it alone).
    created_at: datetime | None = None


class SqlScriptCollectionResponse(CamelModel):
    id: str
    workspace_id: str
    entity_id: str | None = None
    name: dict
    description: dict
    badges: list | None = None
    readme: dict | str | None = None
    license: dict | None = None
    default_data_source_id: str | None = None
    git_remote_config: dict | None = None
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    organization: dict | None = None
    lineage_id: str | None = None
    parent_lineage_id: str | None = None
    created_at: datetime
    updated_at: datetime
    version: str


class SqlScriptFileCreate(CamelModel):
    id: str
    collection_id: str
    name: str
    type: str = "file"  # 'file' | 'folder'
    parent_id: str | None = None
    content: str | None = None
    order: int = 0
    data_source_id: str | None = None
    created_at: str | None = None


class SqlScriptFileUpdate(CamelModel):
    name: str | None = None
    parent_id: str | None = None
    content: str | None = None
    order: int | None = None
    data_source_id: str | None = None


class SqlScriptFileResponse(CamelModel):
    id: str
    collection_id: str
    name: str
    type: str
    parent_id: str | None = None
    content: str | None = None
    order: int
    data_source_id: str | None = None
    created_at: str | None = None
