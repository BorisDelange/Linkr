from datetime import datetime

from pydantic import Field

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
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None


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
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
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


class DatasetDuplicateRequest(CamelModel):
    name: str


class DatasetDataResponse(CamelModel):
    rows: list[dict]


class DatasetRowFilter(CamelModel):
    """One column filter, mirroring ColumnFilterInput's per-type shapes."""

    col_id: str
    value: str | None = None  # boolean ('true'/'false') or text substring
    min: float | None = None
    max: float | None = None
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None


class DatasetNaFilter(CamelModel):
    col_id: str
    mode: str  # 'exclude' | 'only'


class DatasetRowSort(CamelModel):
    col_id: str
    dir: str = "asc"  # 'asc' | 'desc'


class DatasetRowsQuery(CamelModel):
    """Server-side page request: filter/sort/paginate on the Parquet."""

    offset: int = 0
    limit: int = 100
    sort: DatasetRowSort | None = None
    filters: list[DatasetRowFilter] = []
    na: list[DatasetNaFilter] = []


class DatasetRowsPage(CamelModel):
    rows: list[dict]
    total: int


class DatasetDataWrite(CamelModel):
    rows: list[dict]


class DatasetAnalysisCreate(CamelModel):
    id: str | None = None
    project_uid: str
    dataset_path: str
    name: str
    type: str
    config: dict = {}


class DatasetAnalysisUpdate(CamelModel):
    name: str | None = None
    config: dict | None = None


class DatasetAnalysisResponse(CamelModel):
    id: str
    project_uid: str
    dataset_path: str
    name: str
    type: str
    config: dict
    created_at: datetime
    updated_at: datetime
