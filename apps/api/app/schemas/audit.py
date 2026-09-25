from app.schemas.base import CamelModel


class AuditEntry(CamelModel):
    """One access-log line (core/audit.COLUMNS). Never holds result data."""

    seq: int
    at: str
    user_id: int | None = None
    username: str | None = None
    via: str | None = None
    client: str | None = None
    method: str | None = None
    route: str | None = None
    status: int | None = None
    duration_ms: int | None = None
    client_ip: str | None = None
    action: str | None = None
    workspace_id: str | None = None
    project_uid: str | None = None
    data_source_id: str | None = None
    detail: str | None = None
    row_count: int | None = None
    error: str | None = None
    via_kind: str | None = None
    summary: str | None = None
    what: str | None = None


class AuditPage(CamelModel):
    entries: list[AuditEntry]
    total: int
    # column → the values its list filter offers, over the whole log.
    filter_options: dict[str, list[str]] = {}


class AuditVerifyResult(CamelModel):
    ok: bool
    checked: int
    broken_at_seq: int | None = None
