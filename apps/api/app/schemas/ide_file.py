from app.schemas.base import CamelModel


class IdeFileResponse(CamelModel):
    """A node in the disk-derived scripts/ tree (id/parentId derive from path)."""

    id: str
    name: str
    type: str  # 'file' | 'folder'
    parent_id: str | None = None
    path: str
    language: str | None = None
    order: int = 0
    content: str | None = None


class IdeFileCreate(CamelModel):
    project_uid: str
    # Relative path under scripts/ (readable names, e.g. "utils/helpers.R").
    path: str
    type: str = "file"  # 'file' | 'folder'
    content: str | None = None


class IdeFileWrite(CamelModel):
    project_uid: str
    path: str
    content: str


class IdeFileMove(CamelModel):
    project_uid: str
    path: str
    new_path: str


class IdeFileDelete(CamelModel):
    project_uid: str
    path: str
