from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import JSONB_or_JSON, Base, TimestampMixin, UUIDPKMixin


class Workspace(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "workspaces"

    name: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)  # LocalizedString
    description: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    organization_id: Mapped[str | None] = mapped_column(String(36))
    badges: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    # LocalizedString ({"en": ..., "fr": ...}); JSON, not Text.
    readme: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    git_remote_config: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Default package lists for a new project's environments, per language:
    # {"python": ["pandas", "numpy==1.26", …], "r": ["dplyr", …]}. Applied when a
    # project is created in this workspace (see project creation). NULL = built-in
    # data-science defaults.
    default_env_packages: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Default install options for new projects' environments, e.g.
    # {"python": {"indexUrl": "...", "trustedHost": "..."},
    #  "r": {"repos": "...", "method": "curl"}}. Inherited by a project's env unless
    # the env overrides them (per-env options.json). NULL = server defaults.
    default_env_options: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    origin: Mapped[str] = mapped_column(String(10), default="user", server_default="user")
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    # Creator provenance. created_by_id is the stable identity (name resolved live
    # from the directory); created_by / created_by_details are the display snapshot
    # kept for cross-instance imports where the id has no local meaning.
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_by: Mapped[str | None] = mapped_column(Text)
    created_by_details: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Stable cross-instance identity (separate from the local PK). Preserved across
    # export/import; a fork mints a new lineage_id and points parent_lineage_id at its source.
    lineage_id: Mapped[str | None] = mapped_column(String(36))
    parent_lineage_id: Mapped[str | None] = mapped_column(String(36))

    members: Mapped[list["WorkspaceMember"]] = relationship(
        back_populates="workspace",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


from app.models.workspace_member import WorkspaceMember  # noqa: E402  (resolve forward ref)
