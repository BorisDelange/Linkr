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
    read_at: datetime | None = None
    created_at: datetime
