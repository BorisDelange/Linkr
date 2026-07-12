from app.schemas.base import CamelModel


class EntityVisitRecord(CamelModel):
    """Payload to record that the current user just visited an entity."""

    entity_type: str
    entity_id: str
    visited_at: str


class EntityVisitResponse(CamelModel):
    entity_type: str
    entity_id: str
    visited_at: str
