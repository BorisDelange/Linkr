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
    # Persisted parse options (columnTypes/columnFilterMode/delimiter/…) from the
    # sidecar, so the client restores them after a restart and they travel on export.
    parse_options: dict | None = None
    # The edit log. Resolved with the rest of the meta rather than in the tree
    # listing, which stays deliberately meta-free; the client needs it to mint the
    # next row ordinal, so an absent log makes every added row reuse the same one.
    ops: list[dict] | None = None


class DsImport(CamelModel):
    project_uid: str
    # Target relative path under datasets/ (readable name, e.g. "cohort.csv").
    path: str
    # Content hash of the already-uploaded raw file (chunked upload → blob store).
    sha: str
    # Same options the preview used (delimiter/encoding/skipRows/header/sheet), so
    # the persisted parse matches exactly what the user previewed.
    parse_options: dict | None = None


class DsCreateEmpty(CamelModel):
    """Create an empty dataset on disk from a column list.

    The counterpart to /import for a dataset with no uploaded file behind it — a
    manual collection starts empty and is filled row by row. A real CSV carrying
    just the header is written, so the dataset is disk-source-of-truth like every
    other one rather than a special case living only in the client's memory."""

    project_uid: str
    path: str
    columns: list[dict] = []


class DsFromQuery(CamelModel):
    """Write a database query's full result as a Parquet dataset, server-side.

    The rows go from the database to the project's datasets/ folder without
    passing through the caller — which matters when the caller is an agent whose
    context would otherwise carry patient-level data to a model."""

    project_uid: str
    path: str
    data_source_id: str
    sql: str
    replace: bool = False


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
    """Editorial metadata to persist in the disk sidecar. `columns` maps columnId →
    {label?, description?, valueLabels?, withTime?, required?, min?, max?,
    allowedValues?} (authoritative replace) — presentation plus the entry
    constraints a collected variable carries, none of which are derivable from the
    raw file. `parseOptions`,
    when present, replaces the stored parse options (columnFilterMode/columnTypes/…)
    without a reparse — for pure-UI options like filter mode."""

    project_uid: str
    path: str
    columns: dict[str, dict] | None = None
    parse_options: dict | None = None


class DsOps(CamelModel):
    """Edit operations to record against a dataset.

    Default semantics are **append**: the client sends only the ops it just made and
    the server concatenates, so two people editing the same dataset (a manual
    collection filled patient by patient) cannot drop each other's work the way an
    authoritative replace would. `replace=True` rewrites the whole log instead —
    for compaction and for a reset to the raw file, where rewriting history is the
    point."""

    project_uid: str
    path: str
    ops: list[dict]
    replace: bool = False


class DsOpsResponse(CamelModel):
    """The dataset node after the edit, plus the resulting log."""

    node: DsNodeResponse
    ops: list[dict]


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
