from datetime import datetime

from app.schemas.base import CamelModel


class WorkspaceCreate(CamelModel):
    id: str | None = None  # client supplies crypto.randomUUID()
    name: dict[str, str]
    description: dict[str, str] = {}
    organization_id: str | None = None
    badges: list[dict] | None = None
    readme: dict | str | None = None
    git_remote_config: dict | None = None
    origin: str = "user"
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    lineage_id: str | None = None
    parent_lineage_id: str | None = None
    # Creation date preserved on import round-trip; absent → server_default now.
    created_at: datetime | None = None


class WorkspaceUpdate(CamelModel):
    name: dict[str, str] | None = None
    description: dict[str, str] | None = None
    organization_id: str | None = None
    badges: list[dict] | None = None
    readme: dict | str | None = None
    git_remote_config: dict | None = None
    # Editable authoring provenance (author re-attribution + org snapshot).
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    lineage_id: str | None = None
    parent_lineage_id: str | None = None


class WorkspaceResponse(CamelModel):
    id: str
    name: dict[str, str]
    description: dict[str, str]
    organization_id: str | None = None
    badges: list[dict] | None = None
    readme: dict | str | None = None
    git_remote_config: dict | None = None
    origin: str
    owner_id: int | None = None
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    lineage_id: str | None = None
    parent_lineage_id: str | None = None
    created_at: datetime
    updated_at: datetime
