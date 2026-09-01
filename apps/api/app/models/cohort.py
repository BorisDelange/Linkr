from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, LocalizedText, TimestampMixin


class Cohort(Base, TimestampMixin):
    """A project's cohort definition: a criteria tree (JSON) plus optional SQL
    override. Cached execution results (count/attrition) are stored but derived —
    recomputed on demand."""

    __tablename__ = "cohorts"

    # Frontend keys cohorts by client-supplied UUID.
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_uid: Mapped[str] = mapped_column(
        ForeignKey("projects.uid", ondelete="CASCADE")
    )
    name: Mapped[dict] = mapped_column(LocalizedText, default=dict)  # LocalizedString
    description: Mapped[dict | None] = mapped_column(LocalizedText)  # LocalizedString
    # Which linked database the cohort runs against. Nullable: a cohort written
    # before the field existed falls back to the project's first usable database.
    data_source_id: Mapped[str | None] = mapped_column(String(36))
    # Portable identity of the database above ({lineageId?, entityId?, label?}).
    # data_source_id is this instance's local UUID and means nothing elsewhere, so
    # this is what the export carries and the import resolves back to a local row.
    data_source_ref: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    level: Mapped[str] = mapped_column(String(20))  # patient | visit | visit_detail | event
    criteria_tree: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    custom_sql: Mapped[str | None] = mapped_column(Text)
    result_count: Mapped[int | None] = mapped_column(Integer)
    attrition: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    # Frozen membership snapshot (level, ids, patientIds, count, materializedAt).
    # Persisted and shared across users in fullstack mode.
    materialization: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Matches CURRENT_SCHEMA_VERSION in the frontend's cohort-store: a row the
    # server creates must not read as stale and get re-migrated on the client.
    schema_version: Mapped[int] = mapped_column(Integer, default=5)
    # User-facing semver (distinct from schema_version, the internal migration
    # counter). Portable across export/import (see Project.version).
    version: Mapped[str] = mapped_column(String(20), default="0.1.0", server_default="0.1.0")
