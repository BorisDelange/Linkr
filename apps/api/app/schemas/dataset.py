from datetime import datetime

from app.schemas.base import CamelModel


class DatasetFileCreate(CamelModel):
    id: str | None = None  # client-supplied uuid
    project_uid: str
    name: str
    type: str = "file"  # 'file' | 'folder'
    parent_id: str | None = None
    columns: list[dict] | None = None
    row_count: int | None = None
    parse_options: dict | None = None
    origin: str = "user"


class DatasetFileUpdate(CamelModel):
    name: str | None = None
    parent_id: str | None = None
    columns: list[dict] | None = None
    row_count: int | None = None
    parse_options: dict | None = None


class DatasetFileResponse(CamelModel):
    id: str
    project_uid: str
    name: str
    type: str
    parent_id: str | None = None
    columns: list[dict] | None = None
    row_count: int | None = None
    parse_options: dict | None = None
    raw_file_name: str | None = None
    origin: str
    created_at: datetime
    updated_at: datetime


class DatasetImportRequest(CamelModel):
    """Import a previously-uploaded blob (identified by its sha) into a new file."""

    project_uid: str
    name: str
    sha: str  # returned by POST /uploads/{id}/complete
    file_name: str
    parent_id: str | None = None
    parse_options: dict | None = None


class DatasetReimportRequest(CamelModel):
    parse_options: dict | None = None


class DatasetDataResponse(CamelModel):
    rows: list[dict]


class DatasetDataWrite(CamelModel):
    rows: list[dict]


class DatasetAnalysisCreate(CamelModel):
    id: str | None = None
    dataset_file_id: str
    name: str
    type: str
    config: dict = {}


class DatasetAnalysisUpdate(CamelModel):
    name: str | None = None
    config: dict | None = None


class DatasetAnalysisResponse(CamelModel):
    id: str
    dataset_file_id: str
    name: str
    type: str
    config: dict
    created_at: datetime
    updated_at: datetime
