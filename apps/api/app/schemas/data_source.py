from datetime import datetime

from app.schemas.base import CamelModel


class DataSourceCreate(CamelModel):
    id: str | None = None  # client-supplied uuid
    workspace_id: str | None = None
    alias: str
    name: str
    description: str = ""
    source_type: str = "database"
    connection_config: dict = {}  # password/token stripped before persistence
    schema_mapping: dict | None = None
    status: str = "configuring"
    stats: dict | None = None
    error_message: str | None = None
    is_vocabulary_reference: bool = False
    origin: str = "user"
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None


class DataSourceUpdate(CamelModel):
    alias: str | None = None
    name: str | None = None
    description: str | None = None
    connection_config: dict | None = None
    schema_mapping: dict | None = None
    status: str | None = None
    stats: dict | None = None
    error_message: str | None = None
    is_vocabulary_reference: bool | None = None


class DataSourceResponse(CamelModel):
    id: str
    workspace_id: str | None = None
    alias: str
    name: str
    description: str
    source_type: str
    connection_config: dict
    schema_mapping: dict | None = None
    status: str
    stats: dict | None = None
    error_message: str | None = None
    is_vocabulary_reference: bool
    origin: str
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    created_at: datetime
    updated_at: datetime


class DataSourceFileImportRequest(CamelModel):
    """Register a previously-uploaded blob (by sha) as a file of a data source."""

    data_source_id: str
    sha: str  # returned by POST /uploads/{id}/complete
    file_name: str
    file_size: int = 0


class DataSourceFileResponse(CamelModel):
    id: str
    data_source_id: str
    file_name: str
    file_size: int
    content_hash: str
    created_at: datetime


class TestConnectionRequest(CamelModel):
    """Test an external database connection server-side.

    The password travels in this request but is never persisted — the server
    opens the connection, introspects the schema, and discards the credential.
    """

    connection_config: dict


class IntrospectedColumn(CamelModel):
    name: str
    type: str
    nullable: bool


class IntrospectedTable(CamelModel):
    name: str
    columns: list[IntrospectedColumn]


class TestConnectionResult(CamelModel):
    ok: bool
    error: str | None = None
    tables: list[IntrospectedTable] = []


class QueryRequest(CamelModel):
    sql: str


class QueryResult(CamelModel):
    rows: list[dict]
