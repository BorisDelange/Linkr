from datetime import datetime

from app.schemas.base import CamelModel


class DataDictionaryCreate(CamelModel):
    id: str
    workspace_id: str
    name: str = ""
    source_repo: str | None = None
    branch: str | None = None


class DataDictionaryUpdate(CamelModel):
    name: str | None = None
    source_repo: str | None = None
    branch: str | None = None


class DataDictionaryResponse(CamelModel):
    id: str
    workspace_id: str
    name: str
    source_repo: str | None = None
    branch: str | None = None
    commit: str | None = None
    synced_at: datetime | None = None
    unit_conversions: list | None = None
    recommended_units: list | None = None
    created_at: datetime
    updated_at: datetime


class IncomingConceptSet(CamelModel):
    """A concept set as read from the dictionary's repository — no local id: the
    sync keys it on `unique_id` (else `source_url`) and keeps an existing set's id."""

    name: str = ""
    description: str = ""
    expression: dict = {}
    source_url: str | None = None
    unique_id: str | None = None
    source_repo: str | None = None
    category: str | None = None
    subcategory: str | None = None
    provenance: str | None = None
    version: str | None = None
    translations: dict | None = None


class DataDictionarySync(CamelModel):
    concept_sets: list[IncomingConceptSet]
    unit_conversions: list | None = None
    recommended_units: list | None = None
    commit: str | None = None


class DataDictionarySyncResult(CamelModel):
    added: int
    updated: int
    removed: int
    unchanged: int
