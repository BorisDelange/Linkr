from sqlalchemy import Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import JSONB_or_JSON, Base, TimestampMixin


class Dashboard(Base, TimestampMixin):
    """A project's dashboard: metadata + display options + filter config. Its tabs
    and widgets live in DashboardTab / DashboardWidget (flat, keyed by parent id),
    mirroring the frontend's three IndexedDB object stores."""

    __tablename__ = "dashboards"

    # Frontend keys dashboards by client-supplied UUID.
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_uid: Mapped[str] = mapped_column(
        ForeignKey("projects.uid", ondelete="CASCADE")
    )
    name: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)  # LocalizedString
    description: Mapped[dict | None] = mapped_column(JSONB_or_JSON)  # LocalizedString
    filter_config: Mapped[list] = mapped_column(JSONB_or_JSON, default=list)
    show_widget_titles: Mapped[bool | None] = mapped_column(Boolean)
    default_dataset_file_id: Mapped[str | None] = mapped_column(String(36))
    widget_spacing: Mapped[int | None] = mapped_column(Integer)
    reload_widgets_on_tab_switch: Mapped[bool | None] = mapped_column(Boolean)
    fit_to_height: Mapped[bool | None] = mapped_column(Boolean)
    grid_v: Mapped[int | None] = mapped_column(Integer)
    origin: Mapped[str] = mapped_column(String(10), default="user", server_default="user")
    # Stable creator identity (name resolved live from the directory); created_by /
    # created_by_details are the display snapshot kept for cross-instance imports.
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_by: Mapped[str | None] = mapped_column(Text)
    created_by_details: Mapped[dict | None] = mapped_column(JSONB_or_JSON)


class DashboardTab(Base):
    """A tab in a dashboard. `parent_tab_id` (self-referential, not an FK so an
    orphaned sub-tab survives a parent delete) nests a tab under a container tab."""

    __tablename__ = "dashboard_tabs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    dashboard_id: Mapped[str] = mapped_column(
        ForeignKey("dashboards.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(255), default="")
    display_order: Mapped[int] = mapped_column(Integer, default=0)
    parent_tab_id: Mapped[str | None] = mapped_column(String(36))


class DashboardWidget(Base):
    """A widget in a tab. `source` (JSON) holds the discriminated union: a plugin
    reference + config, or an inline code widget whose short code lives inline in
    the JSON (no blob store — mirrors etl_files/sql_script_files)."""

    __tablename__ = "dashboard_widgets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    tab_id: Mapped[str] = mapped_column(
        ForeignKey("dashboard_tabs.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(255), default="")
    dataset_file_id: Mapped[str | None] = mapped_column(String(36))
    layout: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
    source: Mapped[dict] = mapped_column(JSONB_or_JSON, default=dict)
