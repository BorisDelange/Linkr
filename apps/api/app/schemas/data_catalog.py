from datetime import datetime

from app.schemas.base import CamelModel


class DataCatalogCreate(CamelModel):
    id: str
    workspace_id: str
    entity_id: str | None = None
    git_remote_config: dict | None = None
    name: dict = {}
    description: dict = {}
    # Defaults to "" so a git-linked catalog can be created from a minimal
    # workspace pointer; the clone re-applies the real data source id from the repo.
    data_source_id: str = ""
    dimensions: list = []
    anonymization: dict = {}
    category_column: str | None = None
    subcategory_column: str | None = None
    period_config: dict | None = None
    status: str = "draft"
    last_error: str | None = None
    last_computed_at: str | None = None
    last_compute_duration_ms: int | None = None
    dcat_ap_metadata: dict | None = None
    origin: str = "user"
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    organization: dict | None = None
    lineage_id: str | None = None
    parent_lineage_id: str | None = None
    # Creation date preserved on import round-trip; absent → server_default now.
    created_at: datetime | None = None
    version: str = "0.1.0"


class DataCatalogUpdate(CamelModel):
    entity_id: str | None = None
    git_remote_config: dict | None = None
    name: dict | None = None
    description: dict | None = None
    data_source_id: str | None = None
    dimensions: list | None = None
    anonymization: dict | None = None
    category_column: str | None = None
    subcategory_column: str | None = None
    period_config: dict | None = None
    status: str | None = None
    last_error: str | None = None
    last_computed_at: str | None = None
    last_compute_duration_ms: int | None = None
    dcat_ap_metadata: dict | None = None
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


class DataCatalogResponse(CamelModel):
    id: str
    workspace_id: str
    entity_id: str | None = None
    git_remote_config: dict | None = None
    name: dict
    description: dict
    data_source_id: str
    dimensions: list
    anonymization: dict
    category_column: str | None = None
    subcategory_column: str | None = None
    period_config: dict | None = None
    status: str
    last_error: str | None = None
    last_computed_at: str | None = None
    last_compute_duration_ms: int | None = None
    dcat_ap_metadata: dict | None = None
    origin: str
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    organization: dict | None = None
    lineage_id: str | None = None
    parent_lineage_id: str | None = None
    created_at: datetime
    updated_at: datetime
    version: str
