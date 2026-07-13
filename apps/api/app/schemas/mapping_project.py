from datetime import datetime

from app.schemas.base import CamelModel


class MappingProjectCreate(CamelModel):
    id: str
    workspace_id: str
    entity_id: str | None = None
    name: dict = {}
    description: dict = {}
    status: str | None = None
    badges: list | None = None
    source_type: str
    data_source_id: str | None = None
    vocabulary_data_source_id: str | None = None
    file_source_data: dict | None = None
    raw_file_sha: str | None = None
    raw_file_name: str | None = None
    scores_file_sha: str | None = None
    scores_file_name: str | None = None
    concept_set_ids: list | None = None
    stats: dict | None = None
    import_batches: list | None = None
    git_remote_config: dict | None = None
    origin: str = "user"
    organization: dict | None = None


class MappingProjectUpdate(CamelModel):
    entity_id: str | None = None
    name: dict | None = None
    description: dict | None = None
    status: str | None = None
    badges: list | None = None
    source_type: str | None = None
    data_source_id: str | None = None
    vocabulary_data_source_id: str | None = None
    file_source_data: dict | None = None
    raw_file_sha: str | None = None
    raw_file_name: str | None = None
    scores_file_sha: str | None = None
    scores_file_name: str | None = None
    concept_set_ids: list | None = None
    stats: dict | None = None
    import_batches: list | None = None
    git_remote_config: dict | None = None


class MappingProjectResponse(CamelModel):
    id: str
    workspace_id: str
    entity_id: str | None = None
    name: dict
    description: dict
    status: str | None = None
    badges: list | None = None
    source_type: str
    data_source_id: str | None = None
    vocabulary_data_source_id: str | None = None
    file_source_data: dict | None = None
    raw_file_sha: str | None = None
    raw_file_name: str | None = None
    scores_file_sha: str | None = None
    scores_file_name: str | None = None
    concept_set_ids: list | None = None
    stats: dict | None = None
    import_batches: list | None = None
    git_remote_config: dict | None = None
    origin: str
    organization: dict | None = None
    created_at: datetime
    updated_at: datetime


# --- Concept mappings ------------------------------------------------------

class ConceptMappingBase(CamelModel):
    source_concept_id: int | None = None
    source_concept_name: str | None = None
    source_vocabulary_id: str | None = None
    source_domain_id: str | None = None
    source_concept_code: str | None = None
    source_frequency: int | None = None
    source_category_id: str | None = None
    source_subcategory_id: str | None = None
    source_concept_class_id: str | None = None
    target_concept_id: int | None = None
    target_concept_name: str | None = None
    target_vocabulary_id: str | None = None
    target_domain_id: str | None = None
    target_concept_code: str | None = None
    target_concept_class_id: str | None = None
    target_standard_concept: str | None = None
    concept_set_id: str | None = None
    mapping_type: str | None = None
    equivalence: str | None = None
    status: str | None = None
    match_score: float | None = None
    comments: list | None = None
    reviews: list | None = None
    mapped_by: str | None = None
    mapped_by_details: dict | None = None
    mapped_on: str | None = None
    assigned_reviewer: str | None = None
    reviewed_by: str | None = None
    reviewed_by_details: dict | None = None
    reviewed_on: str | None = None
    review_comment: str | None = None


class ConceptMappingCreate(ConceptMappingBase):
    id: str
    project_id: str


class ConceptMappingUpdate(ConceptMappingBase):
    pass


class ConceptMappingResponse(ConceptMappingBase):
    id: str
    project_id: str
    created_at: datetime
    updated_at: datetime


class ConceptMappingBatch(CamelModel):
    mappings: list[ConceptMappingCreate]


class ConceptMappingDeleteByProjects(CamelModel):
    project_ids: list[str]


class ConceptMappingDeleteOrphans(CamelModel):
    valid_project_ids: list[str]


# --- Service mappings ------------------------------------------------------

class ServiceMappingCreate(CamelModel):
    id: str
    workspace_id: str
    name: str = ""
    description: str = ""
    rules: list = []


class ServiceMappingUpdate(CamelModel):
    name: str | None = None
    description: str | None = None
    rules: list | None = None


class ServiceMappingResponse(CamelModel):
    id: str
    workspace_id: str
    name: str
    description: str
    rules: list
    created_at: datetime
    updated_at: datetime
