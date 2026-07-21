from datetime import datetime

from app.schemas.base import CamelModel


class CohortCreate(CamelModel):
    id: str
    project_uid: str
    name: str = ""
    description: str = ""
    level: str
    criteria_tree: dict = {}
    custom_sql: str | None = None
    result_count: int | None = None
    attrition: list | None = None
    materialization: dict | None = None
    schema_version: int = 3
    # Creation date preserved on import round-trip; absent → server_default stamps now.
    created_at: datetime | None = None


class CohortUpdate(CamelModel):
    name: str | None = None
    description: str | None = None
    level: str | None = None
    criteria_tree: dict | None = None
    custom_sql: str | None = None
    result_count: int | None = None
    attrition: list | None = None
    materialization: dict | None = None
    schema_version: int | None = None


class CohortResponse(CamelModel):
    id: str
    project_uid: str
    name: str
    description: str
    level: str
    criteria_tree: dict
    custom_sql: str | None = None
    result_count: int | None = None
    attrition: list | None = None
    materialization: dict | None = None
    schema_version: int
    created_at: datetime
    updated_at: datetime
