from sqlalchemy import Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


class WikiPage(Base, TimestampMixin):
    __tablename__ = "wiki_pages"

    # Frontend keys wiki pages by `id` (client-supplied UUID).
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    workspace_id: Mapped[str | None] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    # Human-readable, URL-safe id set once at creation (folder name in exports).
    entity_id: Mapped[str | None] = mapped_column(String(255))
    # Self-referential hierarchy; not an FK so orphaned children survive a parent
    # delete (the frontend re-parents them). Nullable = top-level page.
    parent_id: Mapped[str | None] = mapped_column(String(36))
    title: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)  # LocalizedString
    slug: Mapped[str] = mapped_column(String(255), default="")
    icon: Mapped[str | None] = mapped_column(String(255))
    content: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)  # LocalizedString
    template: Mapped[str | None] = mapped_column(String(255))
    owner: Mapped[str | None] = mapped_column(String(255))
    verified: Mapped[bool | None] = mapped_column(Boolean)
    verified_at: Mapped[str | None] = mapped_column(String(40))
    review_due_at: Mapped[str | None] = mapped_column(String(40))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    history: Mapped[list | None] = mapped_column(JSONB_or_JSON)  # WikiSnapshot[]
    # Authored mixin fields (display-name string + structured identity), kept as
    # plain data to round-trip the frontend type faithfully.
    created_by: Mapped[str | None] = mapped_column(Text)
    created_by_details: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
