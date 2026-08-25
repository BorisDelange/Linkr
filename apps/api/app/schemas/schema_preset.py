from datetime import datetime

from app.schemas.base import CamelModel


class SchemaPresetSave(CamelModel):
    """Upsert payload — the frontend's SchemaPresetStorage.save()."""

    preset_id: str
    # Local uuid PK and readable slug, taking over from preset_id — see
    # docs/planning/schema-preset-identity-plan.md. Optional while both shapes
    # coexist: an older client sends neither.
    id: str | None = None
    entity_id: str | None = None
    workspace_id: str | None = None
    # README + licence ({id, name?, text}); the licence text travels as LICENSE.md
    # in exports. Present on Update too — a field missing there is silently dropped
    # on git/import round-trips.
    readme: dict | str | None = None
    license: dict | None = None
    mapping: dict = {}
    git_remote_config: dict | None = None
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    # Creation date preserved on import round-trip; applied only when creating.
    created_at: datetime | None = None
    version: str = "0.1.0"
    # Cross-instance identity, preserved verbatim across export/import.
    lineage_id: str | None = None
    parent_lineage_id: str | None = None


class SchemaPresetResponse(CamelModel):
    preset_id: str
    id: str | None = None
    entity_id: str | None = None
    workspace_id: str | None = None
    readme: dict | str | None = None
    license: dict | None = None
    mapping: dict
    git_remote_config: dict | None = None
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    created_at: datetime
    updated_at: datetime
    version: str
    lineage_id: str | None = None
    parent_lineage_id: str | None = None
