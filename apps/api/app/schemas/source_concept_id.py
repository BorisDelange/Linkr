from pydantic import model_validator

from app.core.path_ids import SegmentId
from app.schemas.base import CamelModel


def entry_id(workspace_id: str, badge_label: str, vocabulary_id: str, concept_code: str) -> str:
    return f"{workspace_id}__{badge_label}__{vocabulary_id}__{concept_code}"


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
    id: SegmentId
    workspace_id: str
    badge_label: str
    vocabulary_id: str
    concept_code: str
    source_concept_id: int
    created_at: str | None = None

    @model_validator(mode="after")
    def _id_names_its_own_fields(self):
        if self.id != entry_id(self.workspace_id, self.badge_label, self.vocabulary_id, self.concept_code):
            raise ValueError("id must be workspaceId__badgeLabel__vocabularyId__conceptCode")
        return self


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
