from datetime import datetime

from app.schemas.base import CamelModel


class SchemaPresetSave(CamelModel):
    """Upsert payload — the frontend's SchemaPresetStorage.save()."""

    preset_id: str
    workspace_id: str | None = None
    mapping: dict = {}


class SchemaPresetResponse(CamelModel):
    preset_id: str
    workspace_id: str | None = None
    mapping: dict
    created_at: datetime
    updated_at: datetime
