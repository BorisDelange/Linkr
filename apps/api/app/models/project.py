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
    # Fernet ciphertext of the git access token; never returned by the API.
    git_remote_secret: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str | None] = mapped_column(String(20))
    badges: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    todos: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    # LocalizedString ({"en": ..., "fr": ...}); JSON, not Text — the client
    # always sends an object. `| str` tolerance is handled at the schema layer.
    notes: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    readme: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    linked_data_source_ids: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    organization: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    catalog_visibility: Mapped[str | None] = mapped_column(String(20))
    origin: Mapped[str] = mapped_column(String(10), default="user", server_default="user")
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    # Creator provenance. created_by_id is the stable identity (name resolved live
    # from the directory); created_by / created_by_details are the display snapshot
    # kept for cross-instance imports where the id has no local meaning.
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_by: Mapped[str | None] = mapped_column(Text)
    created_by_details: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
