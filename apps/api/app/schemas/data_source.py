import re
from datetime import datetime

from pydantic import field_validator

from app.schemas.base import CamelModel

_ROLE_NAME = re.compile(r"[a-z_][a-z0-9_]*", re.IGNORECASE)


class DataSourceCreate(CamelModel):
    id: str | None = None  # client-supplied uuid
    entity_id: str | None = None
    workspace_id: str | None = None
    alias: str
    # LocalizedString. `str` is still accepted so older clients and seed
    # manifests that post a bare name keep working (LocalizedText reads it back).
    name: dict | str
    description: dict | str | None = None
    source_type: str = "database"
    connection_config: dict = {}  # password/token stripped before persistence
    schema_mapping: dict | None = None
    schema_source: dict | None = None
    status: str = "configuring"
    stats: dict | None = None
    error_message: str | None = None
    is_vocabulary_reference: bool = False
    badges: list | None = None
    readme: dict | None = None
    license: dict | None = None
    git_remote_config: dict | None = None
    version: str = "0.1.0"
    organization: dict | None = None
    lineage_id: str | None = None
    parent_lineage_id: str | None = None
    origin: str = "user"
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    # Accepted so an import keeps the creation date its tree carries. Undeclared,
    # model_dump dropped it and server_default stamped now() instead, so every
    # re-import of a git-linked database rewrote createdAt and churned the diff.
    created_at: datetime | None = None


class DataSourceUpdate(CamelModel):
    entity_id: str | None = None
    alias: str | None = None
    name: dict | str | None = None
    description: dict | str | None = None
    connection_config: dict | None = None
    schema_mapping: dict | None = None
    schema_source: dict | None = None
    status: str | None = None
    stats: dict | None = None
    error_message: str | None = None
    is_vocabulary_reference: bool | None = None
    badges: list | None = None
    readme: dict | None = None
    license: dict | None = None
    git_remote_config: dict | None = None
    version: str | None = None
    organization: dict | None = None
    lineage_id: str | None = None
    parent_lineage_id: str | None = None
    # The branch a re-import actually takes when the row already exists: without
    # this the clone's createdAt was silently dropped and the stored date stood.
    created_at: datetime | None = None


class DataSourceResponse(CamelModel):
    id: str
    entity_id: str | None = None
    workspace_id: str | None = None
    alias: str
    name: dict | str
    description: dict | str | None = None
    source_type: str
    connection_config: dict
    schema_mapping: dict | None = None
    schema_source: dict | None = None
    status: str
    stats: dict | None = None
    error_message: str | None = None
    is_vocabulary_reference: bool
    badges: list | None = None
    readme: dict | None = None
    license: dict | None = None
    git_remote_config: dict | None = None
    version: str = "0.1.0"
    organization: dict | None = None
    lineage_id: str | None = None
    parent_lineage_id: str | None = None
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


class ParquetTablePath(CamelModel):
    """One queryable table of a Parquet source, with the absolute path(s) to read.

    Uploaded Parquet lives in the content-addressed blob store, so the path is a
    sha with no extension and the logical table name is NOT recoverable from it.
    Pairing them is the only way a script outside Linkr can reach the same table.
    """

    table: str
    paths: list[str]
    exists: bool = False


class DatabaseConnectionInfo(CamelModel):
    """How to reach this database from OUTSIDE Linkr — an R/Python script, a SQL
    client. What that means depends on the source:

      * managed DuckDB  → the .duckdb file the server owns
      * uploaded file   → the blob path (content-addressed, so no extension)
      * parquet folder  → one blob path per table (see `tables`)
      * postgres/mysql  → host/port/database/schema/user, never the password
    """

    engine: str | None = None
    # One of "file" | "parquet-folder" | "external", or None when undetermined.
    kind: str | None = None
    # File / folder sources.
    path: str | None = None
    exists: bool = False
    # True when the path is a content-addressed blob rather than a name the user
    # would recognise: the UI warns that it has no .duckdb extension.
    blob: bool = False
    # Parquet folders: the table files found there, for a quick sanity check.
    file_names: list[str] = []
    # Parquet folders: table name → blob path(s), resolved the same way the SQL
    # editor resolves bare table names. Empty for other kinds.
    tables: list[ParquetTablePath] = []
    # External engines. The password is NEVER returned (see strip_secrets).
    host: str | None = None
    port: int | None = None
    database: str | None = None
    schema_name: str | None = None
    username: str | None = None
