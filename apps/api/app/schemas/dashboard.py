from datetime import datetime

from app.schemas.base import CamelModel


# Multilingual name is a LocalizedString dict ({"en": ...}), but legacy dashboards
# (and old export ZIPs) may carry a bare string — accept both so imports don't 422.
class DashboardCreate(CamelModel):
    id: str
    project_uid: str
    name: dict | str = {}
    description: dict | str | None = None
    filter_config: list = []
    show_widget_titles: bool | None = None
    default_dataset_file_id: str | None = None
    widget_spacing: int | None = None
    reload_widgets_on_tab_switch: bool | None = None
    fit_to_height: bool | None = None
    grid_v: int | None = None
    origin: str = "user"
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None


class DashboardUpdate(CamelModel):
    name: dict | str | None = None
    description: dict | str | None = None
    filter_config: list | None = None
    show_widget_titles: bool | None = None
    default_dataset_file_id: str | None = None
    widget_spacing: int | None = None
    reload_widgets_on_tab_switch: bool | None = None
    fit_to_height: bool | None = None
    grid_v: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None


class DashboardResponse(CamelModel):
    id: str
    project_uid: str
    name: dict | str
    description: dict | str | None = None
    filter_config: list
    show_widget_titles: bool | None = None
    default_dataset_file_id: str | None = None
    widget_spacing: int | None = None
    reload_widgets_on_tab_switch: bool | None = None
    fit_to_height: bool | None = None
    grid_v: int | None = None
    origin: str
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    created_at: datetime
    updated_at: datetime


# Tab/widget name is a LocalizedString dict ({"en": ...}); legacy rows and old export
# ZIPs may carry a bare string — accept both so imports don't 422.
class DashboardTabCreate(CamelModel):
    id: str
    dashboard_id: str
    name: dict | str = {}
    description: dict | str | None = None
    display_order: int = 0
    parent_tab_id: str | None = None


class DashboardTabUpdate(CamelModel):
    name: dict | str | None = None
    description: dict | str | None = None
    display_order: int | None = None
    parent_tab_id: str | None = None


class DashboardTabResponse(CamelModel):
    id: str
    dashboard_id: str
    name: dict | str
    description: dict | str | None = None
    display_order: int
    parent_tab_id: str | None = None


class DashboardWidgetCreate(CamelModel):
    id: str
    tab_id: str
    name: dict | str = {}
    description: dict | str | None = None
    dataset_file_id: str | None = None
    layout: dict = {}
    source: dict = {}


class DashboardWidgetUpdate(CamelModel):
    name: dict | str | None = None
    description: dict | str | None = None
    dataset_file_id: str | None = None
    layout: dict | None = None
    source: dict | None = None


class DashboardWidgetResponse(CamelModel):
    id: str
    tab_id: str
    name: dict | str
    description: dict | str | None = None
    dataset_file_id: str | None = None
    layout: dict
    source: dict
