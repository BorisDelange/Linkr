from sqlalchemy import BigInteger, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


class MappingProject(Base, TimestampMixin):
    """A workspace-scoped OMOP concept-mapping project. Metadata + config in the
    row; the heavy source CSV lives in the blob store, referenced by raw_file_sha
    (its bytes are never inlined in JSON)."""

    __tablename__ = "mapping_projects"

    # Frontend keys projects by client-supplied UUID.
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    entity_id: Mapped[str | None] = mapped_column(String(255))
    name: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)  # LocalizedString
    description: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    status: Mapped[str | None] = mapped_column(String(20))
    badges: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    source_type: Mapped[str] = mapped_column(String(20))  # 'database' | 'file'
    data_source_id: Mapped[str | None] = mapped_column(String(36))
    vocabulary_data_source_id: Mapped[str | None] = mapped_column(String(36))
    # Parsed-file metadata WITHOUT the raw bytes (columns/columnMapping/parseOptions/
    # totalRowCount/fileName). The bytes are the blob referenced below.
    file_source_data: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    raw_file_sha: Mapped[str | None] = mapped_column(String(64))
    raw_file_name: Mapped[str | None] = mapped_column(String(255))
    # Suggestion-scores parquet (precomputed match scores), same blob pattern as
    # the source file: bytes in the blob store, sha pointer here.
    scores_file_sha: Mapped[str | None] = mapped_column(String(64))
    scores_file_name: Mapped[str | None] = mapped_column(String(255))
    concept_set_ids: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    stats: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    import_batches: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    git_remote_config: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    origin: Mapped[str] = mapped_column(String(10), default="user", server_default="user")
    # User-facing semver, portable across export/import (see Project.version).
    version: Mapped[str] = mapped_column(String(20), default="0.1.0", server_default="0.1.0")
    # Stable creator identity (name resolved live from the directory); created_by /
    # created_by_details are the display snapshot kept for cross-instance imports.
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_by: Mapped[str | None] = mapped_column(Text)
    created_by_details: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Frozen provenance snapshot of the origin organization (not a live link).
    organization: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Stable cross-instance identity (separate from the local PK). Preserved across
    # export/import; a fork mints a new lineage_id and points parent_lineage_id at its source.
    lineage_id: Mapped[str | None] = mapped_column(String(36))
    parent_lineage_id: Mapped[str | None] = mapped_column(String(36))


class ConceptMapping(Base, TimestampMixin):
    """One source→target concept mapping within a project. High row count; loaded
    only per-project. Denormalized source/target scalar fields + JSON comments/
    reviews."""

    __tablename__ = "concept_mappings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("mapping_projects.id", ondelete="CASCADE")
    )
    # Source
    source_concept_id: Mapped[int | None] = mapped_column(BigInteger)
    source_concept_name: Mapped[str | None] = mapped_column(Text)
    source_vocabulary_id: Mapped[str | None] = mapped_column(String(255))
    source_domain_id: Mapped[str | None] = mapped_column(String(255))
    source_concept_code: Mapped[str | None] = mapped_column(String(255))
    source_frequency: Mapped[int | None] = mapped_column(Integer)
    source_category_id: Mapped[str | None] = mapped_column(String(255))
    source_subcategory_id: Mapped[str | None] = mapped_column(String(255))
    source_concept_class_id: Mapped[str | None] = mapped_column(String(255))
    # Target
    target_concept_id: Mapped[int | None] = mapped_column(BigInteger)
    target_concept_name: Mapped[str | None] = mapped_column(Text)
    target_vocabulary_id: Mapped[str | None] = mapped_column(String(255))
    target_domain_id: Mapped[str | None] = mapped_column(String(255))
    target_concept_code: Mapped[str | None] = mapped_column(String(255))
    target_concept_class_id: Mapped[str | None] = mapped_column(String(255))
    target_standard_concept: Mapped[str | None] = mapped_column(String(10))
    # Mapping metadata
    concept_set_id: Mapped[str | None] = mapped_column(String(36))
    mapping_type: Mapped[str | None] = mapped_column(String(50))
    equivalence: Mapped[str | None] = mapped_column(String(30))
    status: Mapped[str | None] = mapped_column(String(30))
    match_score: Mapped[float | None] = mapped_column()
    comments: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    reviews: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    # Provenance / review
    mapped_by: Mapped[str | None] = mapped_column(Text)
    mapped_by_details: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    mapped_on: Mapped[str | None] = mapped_column(String(40))
    assigned_reviewer: Mapped[str | None] = mapped_column(Text)
    reviewed_by: Mapped[str | None] = mapped_column(Text)
    reviewed_by_details: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    reviewed_on: Mapped[str | None] = mapped_column(String(40))
    review_comment: Mapped[str | None] = mapped_column(Text)


class ServiceMapping(Base, TimestampMixin):
    """A workspace-scoped care-site/service grouping (raw values → group label)."""

    __tablename__ = "service_mappings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(255), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    rules: Mapped[list] = mapped_column(JSONB_or_JSON, default=list)
