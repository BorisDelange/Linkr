from app.schemas.base import CamelModel


class IdeConnectionCreate(CamelModel):
    id: str
    project_uid: str
    name: str = ""
    source: str
    data_source_id: str | None = None
    connection_config: dict = {}
    status: str | None = None
    error_message: str | None = None
    created_at: str | None = None


class IdeConnectionUpdate(CamelModel):
    name: str | None = None
    source: str | None = None
    data_source_id: str | None = None
    connection_config: dict | None = None
    status: str | None = None
    error_message: str | None = None


class IdeConnectionResponse(CamelModel):
    id: str
    project_uid: str
    name: str
    source: str
    data_source_id: str | None = None
    # Never includes password/token — stripped and stored encrypted server-side.
    connection_config: dict
    status: str | None = None
    error_message: str | None = None
    created_at: str | None = None
