from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, UUIDPKMixin


class BenchReport(Base, UUIDPKMixin):
    """One run of the copilot's test battery against one model.

    Stored server-side so an admin's evaluation is visible to everyone choosing a
    model, rather than living in the browser that happened to run it.

    Speed is machine-specific — the same model is equally capable everywhere but
    its throughput depends on the hardware — so a report is a statement about a
    deployment, not just about a model. Re-running replaces the previous report
    for the same (workspace, model): an older run is of no use once a newer one
    exists on the same machine.
    """

    __tablename__ = "llm_bench_reports"

    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    model: Mapped[str] = mapped_column(String(200), index=True)
    mode: Mapped[str] = mapped_column(String(20), default="quick")  # quick | full
    lang: Mapped[str] = mapped_column(String(5), default="en")
    surfaces: Mapped[list] = mapped_column(JSONB_or_JSON, default=list)

    passed: Mapped[int] = mapped_column(Integer, default=0)
    total: Mapped[int] = mapped_column(Integer, default=0)
    total_ms: Mapped[int] = mapped_column(Integer, default=0)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    tokens_per_second: Mapped[float] = mapped_column(Float, default=0)
    # Per-case detail: which tests failed and why, which is what decides whether
    # a model is usable — a score alone hides that.
    cases: Mapped[list] = mapped_column(JSONB_or_JSON, default=list)

    ran_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    ran_at: Mapped[object] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
