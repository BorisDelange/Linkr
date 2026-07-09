from app.schemas.base import CamelModel


class ExecutionSessionCreate(CamelModel):
    id: str
    project_uid: str
    name: str = ""


class ExecutionSessionResponse(CamelModel):
    id: str
    project_uid: str
    name: str
