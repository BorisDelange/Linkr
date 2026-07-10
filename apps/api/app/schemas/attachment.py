from app.schemas.base import CamelModel


class ReadmeAttachmentResponse(CamelModel):
    id: str
    project_uid: str
    file_name: str
    mime_type: str
    file_size: int
    created_at: str | None = None


class WikiAttachmentResponse(CamelModel):
    id: str
    page_id: str
    workspace_id: str
    file_name: str
    mime_type: str
    file_size: int
    created_at: str | None = None
