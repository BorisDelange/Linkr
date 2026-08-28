from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


class AppSettings(Base, TimestampMixin):
    """Account-level (per-instance) settings. A single row keyed ``account``.

    Holds the git remote for the *settings* versioning scope (organizations +
    users + roles), and the record of whether the default data was installed.
    The auth token is never stored here — it lives per (user, host) in
    ``git_credentials`` like every other scope, so the JSON config carries only
    ``{url, branch}``.
    """

    __tablename__ = "app_settings"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default="account")
    git_remote_config: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # What the setup wizard did about the default data, as
    # ``{"entryId", "decidedAt", "installed", "workspaceId"}``. This is instance
    # state on purpose: the browser-side seed is keyed on localStorage, so it
    # cannot answer "has this instance been given its default data" for a second
    # user on a second machine — which is exactly the question the wizard asks.
    # NULL = never asked (a pre-existing instance), and the wizard only runs on a
    # userless instance, so it is never re-offered to those.
    default_data: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
