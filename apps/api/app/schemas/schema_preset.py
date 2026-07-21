from datetime import datetime

from app.schemas.base import CamelModel


class SchemaPresetSave(CamelModel):
    """Upsert payload — the frontend's SchemaPresetStorage.save()."""

    preset_id: str
    workspace_id: str | None = None
    mapping: dict = {}
    git_remote_config: dict | None = None
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    # Creation date preserved on import round-trip; applied only when creating.
    created_at: datetime | None = None
    version: str = "0.1.0"


class SchemaPresetResponse(CamelModel):
    preset_id: str
    workspace_id: str | None = None
    mapping: dict
    git_remote_config: dict | None = None
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    created_at: datetime
    updated_at: datetime
    version: str
