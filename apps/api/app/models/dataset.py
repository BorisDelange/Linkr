import uuid

from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


class DatasetFile(Base, TimestampMixin):
    """A node in a project's dataset tree (file or folder).

    Metadata only — heavy content lives in the blob store: parsed rows under
    `data_sha`, the original uploaded file under `raw_sha`.
    """

    __tablename__ = "dataset_files"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    project_uid: Mapped[str] = mapped_column(
        ForeignKey("projects.uid", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(255))
    type: Mapped[str] = mapped_column(String(10))  # 'file' | 'folder'
    parent_id: Mapped[str | None] = mapped_column(
        ForeignKey("dataset_files.id", ondelete="CASCADE")
    )
    columns: Mapped[list | None] = mapped_column(JSONB_or_JSON)
    row_count: Mapped[int | None] = mapped_column(Integer)
    parse_options: Mapped[dict | None] = mapped_column(JSONB_or_JSON)
    # Content-hash pointers into the blob store (nullable for folders / no data).
    data_sha: Mapped[str | None] = mapped_column(String(64))
    raw_sha: Mapped[str | None] = mapped_column(String(64))
    raw_file_name: Mapped[str | None] = mapped_column(String(255))
    origin: Mapped[str] = mapped_column(String(10), default="user", server_default="user")
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))


class DatasetAnalysis(Base, TimestampMixin):
    """A viz/analysis attached to a dataset. Datasets are disk-source-of-truth
    (no DB row), so an analysis is keyed by (project_uid, dataset_path) — the
    relative path under projects/<uid>/datasets/. Orphans (whose dataset path no
    longer exists on disk) are reconciled away on scan."""

    __tablename__ = "dataset_analyses"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    project_uid: Mapped[str] = mapped_column(
        ForeignKey("projects.uid", ondelete="CASCADE")
    )
    dataset_path: Mapped[str] = mapped_column(String(1024))
    name: Mapped[str] = mapped_column(String(255))
    type: Mapped[str] = mapped_column(String(50))
    config: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
