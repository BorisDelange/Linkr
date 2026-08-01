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
    # Restored on import/clone so the original creation date survives a git
    # round-trip; a normal PATCH never sends it (exclude_unset leaves it alone).
    created_at: datetime | None = None


class PipelineResponse(CamelModel):
    id: str
    project_uid: str
    name: dict
    nodes: list
    edges: list
    created_at: datetime
    updated_at: datetime
