from sqlalchemy import ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class GitCredential(Base, TimestampMixin):
    """A user's git access token for one remote host, encrypted at rest (Fernet).

    Tokens are per (user, host), NOT per entity: a personal access token is
    host-scoped in practice (one gitlab.com PAT works for every repo there), and
    keying it to the user means one user can never push with another's token.
    The git ops resolve the host from the remote URL, then look up the token for
    the acting user. The plaintext token is never returned by the API.
    """

    __tablename__ = "git_credentials"
    __table_args__ = (UniqueConstraint("user_id", "host", name="uq_git_credential_user_host"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    # Bare host, lowercased (e.g. "gitlab.com", "framagit.org"). Port included
    # when non-default (e.g. "gitea.local:3000") so distinct hosts don't collide.
    host: Mapped[str] = mapped_column(String(255))
    secret: Mapped[str] = mapped_column(Text)
