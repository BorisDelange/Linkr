import re
from datetime import datetime

from pydantic import field_validator

from app.schemas.base import CamelModel

_ROLE_NAME = re.compile(r"[a-z_][a-z0-9_]*", re.IGNORECASE)


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


class CreateFromDdlRequest(CamelModel):
    """Create an empty, server-owned DuckDB file with the schema's DDL applied."""

    ddl: str


class EtlRunRequest(CamelModel):
    """Run ETL SQL against a managed target, with the other role databases
    attached read-only. `roles` maps a role name (source/vocab) to a data
    source id; the target is the source this request is addressed to."""

    sql: str
    roles: dict[str, str] = {}
    # `mapping.<name>` exports the script reads, as CSV text. They are the
    # mapping project's own rows (a private dictionary's source codes), so they
    # travel with the request instead of being written into the versioned
    # script; the server materialises each as a temp file for the run.
    mapping_data: dict[str, str] = {}

    @field_validator("roles")
    @classmethod
    def _normalise_roles(cls, value: dict[str, str]) -> dict[str, str]:
        """Role names are interpolated into ATTACH identifiers downstream, so they
        must be plain identifiers, and they are lowercased once here so the
        `target` reservation can't be dodged with `Target`/`TARGET`."""
        out: dict[str, str] = {}
        for role, ds_id in value.items():
            if _ROLE_NAME.fullmatch(role) is None:
                raise ValueError(f"invalid role name: {role!r}")
            out[role.lower()] = ds_id
        return out
