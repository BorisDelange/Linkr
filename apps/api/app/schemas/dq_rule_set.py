from datetime import datetime

from app.schemas.base import CamelModel


class DqRuleSetCreate(CamelModel):
    id: str
    workspace_id: str
    entity_id: str | None = None
    git_remote_config: dict | None = None
    name: dict = {}
    description: dict = {}
    data_source_id: str
    status: str = "draft"
    last_run_at: str | None = None
    last_run_duration_ms: int | None = None
    last_score: float | None = None
    origin: str = "user"
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None


class DqRuleSetUpdate(CamelModel):
    entity_id: str | None = None
    git_remote_config: dict | None = None
    name: dict | None = None
    description: dict | None = None
    data_source_id: str | None = None
    status: str | None = None
    last_run_at: str | None = None
    last_run_duration_ms: int | None = None
    last_score: float | None = None


class DqRuleSetResponse(CamelModel):
    id: str
    workspace_id: str
    entity_id: str | None = None
    git_remote_config: dict | None = None
    name: dict
    description: dict
    data_source_id: str
    status: str
    last_run_at: str | None = None
    last_run_duration_ms: int | None = None
    last_score: float | None = None
    origin: str
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    created_at: datetime
    updated_at: datetime


class DqCustomCheckCreate(CamelModel):
    id: str
    rule_set_id: str
    name: str = ""
    description: str = ""
    category: str
    severity: str
    threshold: float = 0
    sql: str = ""
    order: int = 0


class DqCustomCheckUpdate(CamelModel):
    name: str | None = None
    description: str | None = None
    category: str | None = None
    severity: str | None = None
    threshold: float | None = None
    sql: str | None = None
    order: int | None = None


class DqCustomCheckResponse(CamelModel):
    id: str
    rule_set_id: str
    name: str
    description: str
    category: str
    severity: str
    threshold: float
    sql: str
    order: int
    created_at: datetime
    updated_at: datetime
