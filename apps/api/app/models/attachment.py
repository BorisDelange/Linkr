from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ReadmeAttachment(Base):
    """An image/file attached to a README. Metadata in the DB, the binary in the
    blob store (dedup by sha). Scoped to a project OR a workspace (exactly one of
    project_uid / workspace_id is set) — projects and workspaces both have a
    README."""

    __tablename__ = "readme_attachments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_uid: Mapped[str | None] = mapped_column(
        ForeignKey("projects.uid", ondelete="CASCADE")
    )
    workspace_id: Mapped[str | None] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    file_name: Mapped[str] = mapped_column(String(255))
    mime_type: Mapped[str] = mapped_column(String(255), default="")
    file_size: Mapped[int] = mapped_column(Integer, default=0)
    blob_sha: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[str | None] = mapped_column(String(40))


class WikiAttachment(Base):
    """An image/file attached to a wiki page. Same blob-store pattern as
    ReadmeAttachment; scoped to the page (FK cascade) and to the workspace (for
    getByWorkspace / deleteByWorkspace)."""

    __tablename__ = "wiki_attachments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    page_id: Mapped[str] = mapped_column(
        ForeignKey("wiki_pages.id", ondelete="CASCADE")
    )
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    file_name: Mapped[str] = mapped_column(String(255))
    mime_type: Mapped[str] = mapped_column(String(255), default="")
    file_size: Mapped[int] = mapped_column(Integer, default=0)
    blob_sha: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[str | None] = mapped_column(String(40))
