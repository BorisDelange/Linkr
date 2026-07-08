from app.schemas.base import CamelModel


class SourceConceptIdRangeSave(CamelModel):
    workspace_id: str
    badge_label: str
    range_start: int
    range_end: int
    next_id: int
    total_concepts: int | None = None
    created_at: str | None = None
    updated_at: str | None = None


class SourceConceptIdRangeResponse(CamelModel):
    workspace_id: str
    badge_label: str
    range_start: int
    range_end: int
    next_id: int
    total_concepts: int | None = None
    created_at: str | None = None
    updated_at: str | None = None


class SourceConceptIdEntrySave(CamelModel):
    id: str
    workspace_id: str
    badge_label: str
    vocabulary_id: str
    concept_code: str
    source_concept_id: int
    created_at: str | None = None


class SourceConceptIdEntryResponse(CamelModel):
    id: str
    workspace_id: str
    badge_label: str
    vocabulary_id: str
    concept_code: str
    source_concept_id: int
    created_at: str | None = None


class SourceConceptIdEntryBatch(CamelModel):
    entries: list[SourceConceptIdEntrySave]
