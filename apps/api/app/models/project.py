import uuid

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


class Project(Base, TimestampMixin):
    __tablename__ = "projects"

    # The frontend identifies projects by `uid` (client-generated); use it as PK.
    uid: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    # Human-readable, URL-safe id set once at creation (folder name in exports).
    project_id: Mapped[str | None] = mapped_column(String(255))
    workspace_id: Mapped[str | None] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    name: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    description: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    short_description: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    config: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    git_remote_config: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Absolute server paths for the three project dirs (server mode). NULL = the
    # default. Independent roles: ide_path is the working dir the IDE shows and the
    # terminal/kernel start in (default projects/<uid>); scripts_path is the code
    # sub-tree packaged as scripts/ on export (default projects/<uid>/scripts);
    # datasets_path is where datasets live (default projects/<uid>/datasets).
    # Machine-local: never exported/versioned/serialized (see project_export) —
    # reconfigured after import.
    ide_path: Mapped[str | None] = mapped_column(Text)
    scripts_path: Mapped[str | None] = mapped_column(Text)
    datasets_path: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str | None] = mapped_column(String(20))
    badges: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    todos: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    # LocalizedString ({"en": ..., "fr": ...}); JSON, not Text — the client
    # always sends an object. `| str` tolerance is handled at the schema layer.
    notes: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    readme: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    linked_data_source_ids: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    organization: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Stable cross-instance identity (separate from the local PK). Preserved across
    # export/import; a fork mints a new lineage_id and points parent_lineage_id at its source.
    lineage_id: Mapped[str | None] = mapped_column(String(36))
    parent_lineage_id: Mapped[str | None] = mapped_column(String(36))
    catalog_visibility: Mapped[str | None] = mapped_column(String(20))
    origin: Mapped[str] = mapped_column(String(10), default="user", server_default="user")
    # User-facing semver, bumped by hand in the edit dialog. Portable (kept in
    # exports/git, preserved on import) — distinct from APP_VERSION (the app build).
    version: Mapped[str] = mapped_column(String(20), default="0.1.0", server_default="0.1.0")
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    # Creator provenance. created_by_id is the stable identity (name resolved live
    # from the directory); created_by / created_by_details are the display snapshot
    # kept for cross-instance imports where the id has no local meaning.
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_by: Mapped[str | None] = mapped_column(Text)
    created_by_details: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
