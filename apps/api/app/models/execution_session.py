from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class ExecutionSession(Base, TimestampMixin):
    """A named execution session (kernel namespace) for a user in a project.

    A session isolates a kernel's variable namespace — like a separate console in
    RStudio or a terminal in VS Code. It is per-user (never shared: a session
    carries live variables), matching how the kernel registry keys its processes
    by (project, user, language, env). Same interpreter/packages across sessions
    for now — a session is a namespace, not a virtualenv.
    """

    __tablename__ = "execution_sessions"

    # Client-supplied UUID, used as the kernel's env_id.
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_uid: Mapped[str] = mapped_column(String(36), index=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(255), default="")
