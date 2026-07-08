from datetime import datetime

from app.schemas.base import CamelModel


class ConceptSetCreate(CamelModel):
    id: str
    workspace_id: str
    name: str = ""
    description: str = ""
    expression: dict = {}
    resolved_concept_ids: list | None = None
    source_url: str | None = None
    unique_id: str | None = None
    source_repo: str | None = None
    category: str | None = None
    subcategory: str | None = None
    provenance: str | None = None
    version: str | None = None
    import_batch_id: str | None = None
    translations: dict | None = None


class ConceptSetUpdate(CamelModel):
    name: str | None = None
    description: str | None = None
    expression: dict | None = None
    resolved_concept_ids: list | None = None
    source_url: str | None = None
    unique_id: str | None = None
    source_repo: str | None = None
    category: str | None = None
    subcategory: str | None = None
    provenance: str | None = None
    version: str | None = None
    import_batch_id: str | None = None
    translations: dict | None = None


class ConceptSetResponse(CamelModel):
    id: str
    workspace_id: str
    name: str
    description: str
    expression: dict
    resolved_concept_ids: list | None = None
    source_url: str | None = None
    unique_id: str | None = None
    source_repo: str | None = None
    category: str | None = None
    subcategory: str | None = None
    provenance: str | None = None
    version: str | None = None
    import_batch_id: str | None = None
    translations: dict | None = None
    created_at: datetime
    updated_at: datetime


class ConceptSetDeleteBatch(CamelModel):
    ids: list[str]
