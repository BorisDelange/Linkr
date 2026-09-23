from datetime import datetime

from app.schemas.base import CamelModel


class NotificationResponse(CamelModel):
    id: str
    source: str
    action: str
    entity_type: str
    entity_id: str
    project_uid: str | None = None
    label: dict | str
    detail: dict | None = None
    read_at: datetime | None = None
    undone_at: datetime | None = None
    # Computed: an undo is stored, not yet applied, and no later change touched the same item.
    undoable: bool = False
    created_at: datetime
