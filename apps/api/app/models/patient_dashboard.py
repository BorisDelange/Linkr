from sqlalchemy import Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


class PatientDashboard(Base, TimestampMixin):
    """A project's patient-data board: the Warehouse counterpart of Dashboard. Same
    flat three-table shape (board / tabs / widgets keyed by parent id), but bound to
    the project's OMOP data source rather than to a dataset, so there is no
    filter_config / default_dataset_file_id here."""

    __tablename__ = "patient_dashboards"

    # Frontend keys boards by client-supplied UUID.
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_uid: Mapped[str] = mapped_column(
        ForeignKey("projects.uid", ondelete="CASCADE")
    )
    name: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)  # LocalizedString
    description: Mapped[dict | None] = mapped_column(JSONB_or_JSON)  # LocalizedString
    show_widget_titles: Mapped[bool | None] = mapped_column(Boolean)
    widget_spacing: Mapped[int | None] = mapped_column(Integer)
    fit_to_height: Mapped[bool | None] = mapped_column(Boolean)
    reload_widgets_on_tab_switch: Mapped[bool | None] = mapped_column(Boolean)
    sync_timelines_across_tabs: Mapped[bool | None] = mapped_column(Boolean)
    display_order: Mapped[int] = mapped_column(Integer, default=0)
    origin: Mapped[str] = mapped_column(String(10), default="user", server_default="user")
    # User-facing semver, portable across export/import (see Project.version).
    version: Mapped[str] = mapped_column(String(20), default="0.1.0", server_default="0.1.0")
    # Stable creator identity (name resolved live from the directory); created_by /
    # created_by_details are the display snapshot kept for cross-instance imports.
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_by: Mapped[str | None] = mapped_column(Text)
    created_by_details: Mapped[dict | None] = mapped_column(JSONB_or_JSON)


class PatientDashboardTab(Base):
    """A tab in a patient-data board. Unlike DashboardTab there is no nesting: the
    board itself is the grouping level, so tabs stay a flat ordered list."""

    __tablename__ = "patient_dashboard_tabs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    patient_dashboard_id: Mapped[str] = mapped_column(
        ForeignKey("patient_dashboards.id", ondelete="CASCADE")
    )
    name: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)  # LocalizedString
    description: Mapped[dict | None] = mapped_column(JSONB_or_JSON)  # LocalizedString
    display_order: Mapped[int] = mapped_column(Integer, default=0)


class PatientDashboardWidget(Base):
    """A widget in a tab. Always a plugin reference (no inline-code variant here),
    so plugin_id / language / config are columns rather than a `source` union."""

    __tablename__ = "patient_dashboard_widgets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    tab_id: Mapped[str] = mapped_column(
        ForeignKey("patient_dashboard_tabs.id", ondelete="CASCADE")
    )
    name: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)  # LocalizedString
    description: Mapped[dict | None] = mapped_column(JSONB_or_JSON)  # LocalizedString
    layout: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    plugin_id: Mapped[str] = mapped_column(String(100))
    language: Mapped[str | None] = mapped_column(String(10))
    config: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    custom_sql: Mapped[str | None] = mapped_column(Text)
    plugin_version: Mapped[str | None] = mapped_column(String(20))
