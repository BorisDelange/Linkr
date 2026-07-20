from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


class AppSettings(Base, TimestampMixin):
    """Account-level (per-instance) settings. A single row keyed ``account``.

    Today it only holds the git remote for the *settings* versioning scope
    (organizations + users + roles). The auth token is never stored here — it
    lives per (user, host) in ``git_credentials`` like every other scope, so the
    JSON config carries only ``{url, branch}``.
    """

    __tablename__ = "app_settings"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default="account")
    git_remote_config: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
