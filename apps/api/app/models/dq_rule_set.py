from sqlalchemy import Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


class DqRuleSet(Base, TimestampMixin):
    """A workspace-scoped data-quality rule set (metadata; the checks are rows in
    DqCustomCheck). Cached run results (score/timings) are stored but derived."""

    __tablename__ = "dq_rule_sets"

    # Frontend keys rule sets by client-supplied UUID.
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    # Human-readable, URL-safe id set once at creation.
    entity_id: Mapped[str | None] = mapped_column(String(255))
    name: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)  # LocalizedString
    description: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    data_source_id: Mapped[str] = mapped_column(String(36))
    status: Mapped[str] = mapped_column(String(20), default="draft")
    last_run_at: Mapped[str | None] = mapped_column(String(40))
    last_run_duration_ms: Mapped[int | None] = mapped_column(Integer)
    last_score: Mapped[float | None] = mapped_column(Float)
    origin: Mapped[str] = mapped_column(String(10), default="user", server_default="user")
    created_by: Mapped[str | None] = mapped_column(Text)
    created_by_details: Mapped[dict | None] = mapped_column(JSONB_or_JSON)


class DqCustomCheck(Base, TimestampMixin):
    """A single SQL data-quality check within a rule set. Plain-string name/
    description (not localized); short inline SQL. Has createdAt + updatedAt."""

    __tablename__ = "dq_custom_checks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    rule_set_id: Mapped[str] = mapped_column(
        ForeignKey("dq_rule_sets.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(255), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    category: Mapped[str] = mapped_column(String(20))
    severity: Mapped[str] = mapped_column(String(10))
    threshold: Mapped[float] = mapped_column(Float, default=0)
    sql: Mapped[str] = mapped_column(Text, default="")
    order: Mapped[int] = mapped_column(Integer, default=0)
