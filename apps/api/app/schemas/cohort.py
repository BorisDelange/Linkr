from datetime import datetime

from app.schemas.base import CamelModel


class CohortCreate(CamelModel):
    id: str
    project_uid: str
    name: str = ""
    description: str = ""
    data_source_id: str | None = None
    data_source_ref: dict | None = None
    level: str
    criteria_tree: dict = {}
    custom_sql: str | None = None
    result_count: int | None = None
    attrition: list | None = None
    materialization: dict | None = None
    schema_version: int = 3
    # Creation date preserved on import round-trip; absent → server_default stamps now.
    created_at: datetime | None = None
    version: str = "0.1.0"


class CohortUpdate(CamelModel):
    name: str | None = None
    description: str | None = None
    data_source_id: str | None = None
    data_source_ref: dict | None = None
    level: str | None = None
    criteria_tree: dict | None = None
    custom_sql: str | None = None
    result_count: int | None = None
    attrition: list | None = None
    materialization: dict | None = None
    schema_version: int | None = None
    version: str | None = None
    # Restored on import/clone so the original creation date survives a git
    # round-trip; a normal PATCH never sends it (exclude_unset leaves it alone).
    created_at: datetime | None = None


class CohortResponse(CamelModel):
    id: str
    project_uid: str
    name: str
    description: str
    data_source_id: str | None = None
    data_source_ref: dict | None = None
    level: str
    criteria_tree: dict
    custom_sql: str | None = None
    result_count: int | None = None
    attrition: list | None = None
    materialization: dict | None = None
    schema_version: int
    created_at: datetime
    updated_at: datetime
    version: str
