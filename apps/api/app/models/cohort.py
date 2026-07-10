from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


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
    name: Mapped[str] = mapped_column(String(255), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    level: Mapped[str] = mapped_column(String(20))  # patient | visit | visit_detail | event
    criteria_tree: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    custom_sql: Mapped[str | None] = mapped_column(Text)
    result_count: Mapped[int | None] = mapped_column(Integer)
    attrition: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    # Frozen membership snapshot (level, ids, patientIds, count, materializedAt).
    # Persisted and shared across users in fullstack mode.
    materialization: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    schema_version: Mapped[int] = mapped_column(Integer, default=3)
