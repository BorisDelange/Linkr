from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


class EtlPipeline(Base, TimestampMixin):
    """A workspace-scoped ETL pipeline (metadata + DAG config; the scripts
    themselves are a file tree in EtlFile)."""

    __tablename__ = "etl_pipelines"

    # Frontend keys pipelines by client-supplied UUID.
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    # Human-readable, URL-safe id set once at creation (folder name in exports).
    entity_id: Mapped[str | None] = mapped_column(String(255))
    name: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)  # LocalizedString
    description: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    # Badges for grouping/tagging (list of {id, label, color}).
    badges: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    source_data_source_id: Mapped[str | None] = mapped_column(String(36))
    target_data_source_id: Mapped[str | None] = mapped_column(String(36))
    mapping_project_id: Mapped[str | None] = mapped_column(String(36))
    status: Mapped[str] = mapped_column(String(20), default="draft")
    last_run_at: Mapped[str | None] = mapped_column(String(40))
    last_run_duration_ms: Mapped[int | None] = mapped_column(Integer)
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
    # Per-file versioning marks, mirroring Project.config:
    #   versionedDataFiles — data files (gitignored by default) explicitly INCLUDED
    #   excludedFiles      — code files (versioned by default) explicitly EXCLUDED
    # Keyed by the file's path inside the pipeline, which is what the export tree
    # and the .gitignore exceptions use.
    config: Mapped[dict | None] = mapped_column(JSONB_or_JSON)


class EtlRunHistory(Base):
    """One persisted pipeline run: when it started, how it ended, and the per-script
    logs (`scripts`).

    Runs used to live only in the frontend store, so a reload lost every trace of
    what had been executed against the target — the one thing an ETL run is worth
    keeping. `scripts` holds the EtlRunLog list as JSON rather than a child table:
    it is written once per progress tick as an opaque blob and is never queried by
    its contents.
    """

    __tablename__ = "etl_run_history"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    pipeline_id: Mapped[str] = mapped_column(
        ForeignKey("etl_pipelines.id", ondelete="CASCADE")
    )
    started_at: Mapped[str] = mapped_column(String(40))
    completed_at: Mapped[str | None] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(20))
    scripts: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    # Who launched it: a shared target makes "who ran this" a real question.
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))


class EtlFile(Base):
    """A node (file or folder) in a pipeline's script tree. Script text is short
    and lives inline in `content` — no blob store needed (mirrors SqlScriptFile)."""

    __tablename__ = "etl_files"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    pipeline_id: Mapped[str] = mapped_column(
        ForeignKey("etl_pipelines.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(255))
    type: Mapped[str] = mapped_column(String(10))  # 'file' | 'folder'
    # Self-referential hierarchy; not an FK so orphaned children survive a parent
    # delete (the frontend re-parents them). Nullable = top-level node.
    parent_id: Mapped[str | None] = mapped_column(String(36))
    content: Mapped[str | None] = mapped_column(Text)
    language: Mapped[str | None] = mapped_column(String(10))  # 'sql' | 'python' | 'r'
    order: Mapped[int] = mapped_column(Integer, default=0)
    data_source_id: Mapped[str | None] = mapped_column(String(36))
    disabled: Mapped[bool | None] = mapped_column()
    created_at: Mapped[str | None] = mapped_column(String(40))
