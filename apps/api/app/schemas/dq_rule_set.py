from datetime import datetime

from pydantic import field_validator, model_validator

from app.schemas.base import CamelModel
from app.schemas.dq_taxonomy import (
    check_threshold,
    normalize_category,
    normalize_severity,
)


class DqRuleSetCreate(CamelModel):
    id: str
    workspace_id: str
    entity_id: str | None = None
    git_remote_config: dict | None = None
    name: dict = {}
    description: dict = {}
    badges: list | None = None
    # README + licence ({id, name?, text}); the licence text travels as LICENSE.md
    # in exports. Present on Update too — a field missing there is silently dropped
    # on git/import round-trips.
    readme: dict | str | None = None
    license: dict | None = None
    # Defaults to "" so a git-linked rule set can be created from a minimal
    # workspace pointer; the clone re-applies the real data source id from the repo.
    data_source_id: str = ""
    # Portable pointer to the database; the import resolves it to a local id.
    data_source_ref: dict | None = None
    schema_preset_ref: dict | None = None
    # Groups holding no check yet; null when none.
    check_groups: list[str] | None = None
    status: str = "draft"
    last_run_at: str | None = None
    last_run_duration_ms: int | None = None
    last_score: float | None = None
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


class DqRuleSetUpdate(CamelModel):
    entity_id: str | None = None
    git_remote_config: dict | None = None
    name: dict | None = None
    description: dict | None = None
    badges: list | None = None
    readme: dict | str | None = None
    license: dict | None = None
    data_source_id: str | None = None
    # Portable pointer to the database; the import resolves it to a local id.
    data_source_ref: dict | None = None
    schema_preset_ref: dict | None = None
    check_groups: list[str] | None = None
    status: str | None = None
    last_run_at: str | None = None
    last_run_duration_ms: int | None = None
    last_score: float | None = None
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


class DqRuleSetResponse(CamelModel):
    id: str
    workspace_id: str
    entity_id: str | None = None
    git_remote_config: dict | None = None
    name: dict
    description: dict
    badges: list | None = None
    readme: dict | str | None = None
    license: dict | None = None
    data_source_id: str
    # Portable pointer to the database; the import resolves it to a local id.
    data_source_ref: dict | None = None
    schema_preset_ref: dict | None = None
    check_groups: list[str] | None = None
    status: str
    last_run_at: str | None = None
    last_run_duration_ms: int | None = None
    last_score: float | None = None
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


class DqCustomCheckCreate(CamelModel):
    id: str
    rule_set_id: str
    name: str = ""
    description: str = ""
    category: str
    subcategory: str | None = None
    severity: str
    threshold: float = 0
    sql: str = ""
    explore_sql: str | None = None
    order: int = 0
    origin: str = "manual"
    template_key: str | None = None
    table_name: str | None = None
    disabled: bool = False

    @model_validator(mode="after")
    def _taxonomy(self):
        self.category, self.subcategory = normalize_category(self.category, self.subcategory)
        self.severity = normalize_severity(self.severity)
        check_threshold(self.threshold)
        return self


class DqCustomCheckUpdate(CamelModel):
    name: str | None = None
    description: str | None = None
    category: str | None = None
    subcategory: str | None = None
    severity: str | None = None
    threshold: float | None = None
    sql: str | None = None
    explore_sql: str | None = None
    order: int | None = None
    # The check's group in the list; null moves it to "Other checks".
    table_name: str | None = None
    disabled: bool | None = None

    @model_validator(mode="after")
    def _no_null_on_required(self):
        # Optional here only so a PATCH can leave them out: an explicit null would
        # write NULL into a NOT NULL column.
        for field in ("name", "description", "category", "severity", "threshold", "sql", "order", "disabled"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self

    @field_validator("severity")
    @classmethod
    def _severity(cls, v: str | None) -> str | None:
        return None if v is None else normalize_severity(v)

    @field_validator("threshold")
    @classmethod
    def _threshold(cls, v: float | None) -> float | None:
        return None if v is None else check_threshold(v)


class DqCustomCheckPatch(DqCustomCheckUpdate):
    """One check's changes in a batch update."""
    id: str


class DqChecksDelete(CamelModel):
    ids: list[str]


class DqCustomCheckResponse(CamelModel):
    id: str
    rule_set_id: str
    name: str
    description: str
    category: str
    subcategory: str | None = None
    severity: str
    threshold: float
    sql: str
    explore_sql: str | None = None
    order: int
    origin: str
    template_key: str | None = None
    table_name: str | None = None
    disabled: bool
    created_at: datetime
    updated_at: datetime


class DqRunHistoryCreate(CamelModel):
    id: str
    # Required (like DqCustomCheckCreate.rule_set_id): the route authorizes the
    # write via this rule set's workspace, so a null value must not slip past the
    # `if body.rule_set_id` guard and let any authed user write an orphan run.
    rule_set_id: str
    workspace_id: str | None = None
    data_source_id: str
    started_at: str
    completed_at: str | None = None
    status: str
    score: float | None = None
    total_checks: int = 0
    passed: int = 0
    failed: int = 0
    errors: int = 0
    not_applicable: int = 0
    duration_ms: int | None = None
    report: dict | None = None


class DqRunHistoryUpdate(CamelModel):
    completed_at: str | None = None
    status: str | None = None
    score: float | None = None
    total_checks: int | None = None
    passed: int | None = None
    failed: int | None = None
    errors: int | None = None
    not_applicable: int | None = None
    duration_ms: int | None = None
    report: dict | None = None


class DqRunHistoryResponse(CamelModel):
    id: str
    rule_set_id: str | None = None
    workspace_id: str | None = None
    data_source_id: str
    started_at: str
    completed_at: str | None = None
    status: str
    score: float | None = None
    total_checks: int
    passed: int
    failed: int
    errors: int
    not_applicable: int
    duration_ms: int | None = None
    report: dict | None = None
