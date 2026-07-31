from sqlalchemy import ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPKMixin


class Environment(Base, UUIDPKMixin, TimestampMixin):
    """The Python or R environment of a project — its interpreter + package set.

    Exactly one row per (project, language): a project has one Python environment
    and one R environment, versioned in the project git as a manifest+lockfile
    (RStudio+renv / uv model). This row is the DB-side index; the declarative
    spec lives on disk under ``environments/<language>/``.

    ``kind = system`` points at an already-installed interpreter (the seeded
    default — nothing to build, runs immediately); ``kind = managed`` is resolved
    by uv/renv from the committed lockfile. ``interpreter_path`` and ``status``
    are recomputable machine-local state and are never committed to git.

    A live *session* (in-memory namespace) is a separate concept — several sessions
    may run on one environment; see ``ExecutionSession``.
    """

    __tablename__ = "environments"
    __table_args__ = (
        UniqueConstraint("project_uid", "language", name="uq_environments_project_language"),
    )

    project_uid: Mapped[str] = mapped_column(
        ForeignKey("projects.uid", ondelete="CASCADE"), index=True
    )
    language: Mapped[str] = mapped_column(String(16))  # 'python' | 'r'
    kind: Mapped[str] = mapped_column(String(16), default="system")  # 'system' | 'managed'
    status: Mapped[str] = mapped_column(String(16), default="ready")  # draft|building|ready|error
    # Resolved venv python / renv library root — server-computed, machine-local,
    # NULL for a system env (it uses the shared interpreter). Never in git.
    interpreter_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
