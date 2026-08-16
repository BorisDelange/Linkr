from datetime import datetime

from app.schemas.base import CamelModel


class ConceptListCreate(CamelModel):
    id: str
    project_uid: str
    name: dict = {}
    description: dict = {}
    items: list = []
    data_source_id: str | None = None
    # Creation date preserved on import round-trip; absent → server_default stamps now.
    created_at: datetime | None = None
    version: str = "0.1.0"


class ConceptListUpdate(CamelModel):
    name: dict | None = None
    description: dict | None = None
    items: list | None = None
    data_source_id: str | None = None
    version: str | None = None
    # Restored on import/clone so the original creation date survives a git
    # round-trip; a normal PATCH never sends it (exclude_unset leaves it alone).
    created_at: datetime | None = None


class ConceptListResponse(CamelModel):
    id: str
    project_uid: str
    name: dict
    description: dict
    items: list
    data_source_id: str | None = None
    version: str
    created_at: datetime
    updated_at: datetime
