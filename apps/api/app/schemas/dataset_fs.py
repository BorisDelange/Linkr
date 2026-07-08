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
