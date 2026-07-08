from datetime import datetime

from app.schemas.base import CamelModel


class PipelineCreate(CamelModel):
    id: str
    project_uid: str
    name: dict = {}
    nodes: list = []
    edges: list = []


class PipelineUpdate(CamelModel):
    name: dict | None = None
    nodes: list | None = None
    edges: list | None = None


class PipelineResponse(CamelModel):
    id: str
    project_uid: str
    name: dict
    nodes: list
    edges: list
    created_at: datetime
    updated_at: datetime
