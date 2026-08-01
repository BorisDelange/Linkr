from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, JSONB_or_JSON, TimestampMixin, UUIDPKMixin


class Job(Base, UUIDPKMixin, TimestampMixin):
    """A tracked long-running server task (environment build, later long runs).

    DB-backed so it survives a server restart: a job left ``running`` when the
    process dies is reconciled to ``error`` at startup (the row outlives the
    process). Surfaces in the StatusBar jobs panel with progress + a log tail and
    can be cancelled. The executor that runs jobs is bounded (a semaphore) so a
    burst of builds can't exhaust the single uvicorn worker.
    """

    __tablename__ = "jobs"

    project_uid: Mapped[str] = mapped_column(
        ForeignKey("projects.uid", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(32))  # 'build' | 'run' | …
    # A human label for the panel, e.g. "Build Python environment".
    label: Mapped[str] = mapped_column(String(255), default="")
    status: Mapped[str] = mapped_column(String(16), default="queued")
    # queued | running | done | error | cancelled
    progress: Mapped[int] = mapped_column(Integer, default=0)  # 0–100, best-effort
    log_tail: Mapped[str] = mapped_column(Text, default="")
    # For a 'run' job: the batch run's artifacts collected at the end —
    # {"figures": [...], "table": {...}|None, "html": ...}. NULL for other kinds.
    result: Mapped[dict | None] = mapped_column(JSONB_or_JSON, nullable=True)
