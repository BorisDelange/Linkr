from app.core.path_ids import SegmentId
from app.schemas.base import CamelModel


class ExecutionSessionCreate(CamelModel):
    id: SegmentId
    project_uid: str
    language: str = "python"
    name: str = ""


class ExecutionSessionResponse(CamelModel):
    id: str
    project_uid: str
    language: str
    name: str
