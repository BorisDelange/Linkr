from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


class Pipeline(Base, TimestampMixin):
    """A project's transform DAG (nodes + edges). Metadata only — the DAG itself
    is the payload; there is no heavy content to offload to the blob store."""

    __tablename__ = "pipelines"

    # Frontend keys pipelines by a client-supplied UUID id.
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_uid: Mapped[str] = mapped_column(
        ForeignKey("projects.uid", ondelete="CASCADE")
    )
    name: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)  # LocalizedString
    nodes: Mapped[list] = mapped_column(JSONB_or_JSON, default=list)
    edges: Mapped[list] = mapped_column(JSONB_or_JSON, default=list)
