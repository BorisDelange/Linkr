from app.schemas.base import CamelModel


class DsNodeResponse(CamelModel):
    """A node in the disk-derived datasets/ tree (id/parentId derive from path)."""

    id: str
    name: str
    type: str  # 'file' | 'folder'
    parent_id: str | None = None
    path: str
    # Files only: inferred columns + row count (from the parsed Parquet cache).
    columns: list[dict] | None = None
    row_count: int | None = None


class DsImport(CamelModel):
    project_uid: str
    # Target relative path under datasets/ (readable name, e.g. "cohort.csv").
    path: str
    # Content hash of the already-uploaded raw file (chunked upload → blob store).
    sha: str
    # Same options the preview used (delimiter/encoding/skipRows/header/sheet), so
    # the persisted parse matches exactly what the user previewed.
    parse_options: dict | None = None


class DsPreview(CamelModel):
    """Parse an already-uploaded blob WITHOUT persisting it, to drive the import
    dialog's preview server-side (same parser as the eventual import)."""

    project_uid: str
    sha: str
    file_name: str
    parse_options: dict | None = None


class DsPreviewResponse(CamelModel):
    columns: list[dict]
    # First rows keyed by columnId (the same shape rows/query returns).
    preview: list[dict]
    row_count: int
    # Excel only: the workbook's sheet names, to populate the sheet selector.
    sheet_names: list[str] | None = None


class DsPreviewPath(CamelModel):
    """Preview an already-imported dataset re-parsed with new options, WITHOUT
    persisting — drives the Import Settings dialog server-side."""

    project_uid: str
    path: str
    parse_options: dict | None = None


class DsReimport(CamelModel):
    project_uid: str
    path: str
    parse_options: dict | None = None


class DsColumnMeta(CamelModel):
    """Editorial column metadata to persist in the disk sidecar. `columns` maps
    columnId → {label?, description?, valueLabels?}; merged read-modify-write."""

    project_uid: str
    path: str
    columns: dict[str, dict]


class DsDuplicate(CamelModel):
    project_uid: str
    path: str
    new_name: str


class DsCreateFolder(CamelModel):
    project_uid: str
    path: str


class DsDelete(CamelModel):
    project_uid: str
    path: str


class DsMove(CamelModel):
    project_uid: str
    path: str
    new_path: str
