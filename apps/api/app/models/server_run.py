from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, PortableJSON, TimestampMixin, UUIDPKMixin

# A run in one of these is going on: at most one per kind and scope.
ACTIVE_STATUSES = ("queued", "running", "pausing")
_ACTIVE_SQL = "status IN ('queued', 'running', 'pausing')"


class ServerRun(Base, UUIDPKMixin, TimestampMixin):
    """A long computation run by the server (services/server_runs): a database's
    concept statistics, a mapping project's extraction, an ETL pipeline, a data
    catalog… The page only reads it and asks for a pause or a resume; a reload, a
    closed tab or a server restart leaves it where it is.

    Its checkpoint is `state`, written as its steps land. `attempt` fences its
    writes: a takeover raises it, and an older executor's writes, conditioned on
    the attempt it started with, then change nothing."""

    __tablename__ = "server_runs"
    __table_args__ = (
        Index(
            "uq_server_runs_active", "kind", "scope_id",
            unique=True,
            sqlite_where=text(_ACTIVE_SQL),
            postgresql_where=text(_ACTIVE_SQL),
        ),
    )

    # The database it reads, when it reads one (services/server_runs/registry).
    data_source_id: Mapped[str | None] = mapped_column(
        ForeignKey("data_sources.id", ondelete="CASCADE"), index=True, nullable=True
    )
    # What it computes (registry.KINDS).
    kind: Mapped[str] = mapped_column(String(32))
    # What it is the run of — a database, a mapping project, a pipeline's target,
    # a catalog: one active run per kind and scope.
    scope_id: Mapped[str] = mapped_column(String(64))
    workspace_id: Mapped[str | None] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True, nullable=True
    )
    # Who started it: its queries read the databases as them.
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    # queued | running | pausing | paused | interrupted | done | failed | cancelled
    status: Mapped[str] = mapped_column(String(16), default="queued")
    # What the page asked last ('pause', 'cancel'): the executor acts on it at
    # its next step, and only it writes `status`.
    requested: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # What the client compiled: fixed for the run's life.
    spec: Mapped[dict] = mapped_column(PortableJSON, default=dict)
    # Checkpoint and progress, the kind's own.
    state: Mapped[dict] = mapped_column(PortableJSON, default=dict)
    attempt: Mapped[int] = mapped_column(Integer, default=0)
    # The server process running it, and until when its claim holds.
    boot_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # The job of the current attempt, for the jobs panel.
    job_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
