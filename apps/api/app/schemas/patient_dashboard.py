from datetime import datetime

from app.schemas.base import CamelModel


# Multilingual name is a LocalizedString dict ({"en": ...}); rows migrated from the
# old localStorage store may carry a bare string — accept both so imports don't 422.
class PatientDashboardCreate(CamelModel):
    id: str
    project_uid: str
    name: dict | str = {}
    description: dict | str | None = None
    show_widget_titles: bool | None = None
    widget_spacing: int | None = None
    fit_to_height: bool | None = None
    display_order: int = 0
    origin: str = "user"
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    # Creation date preserved on import round-trip; absent → server_default now.
    created_at: datetime | None = None
    version: str = "0.1.0"


class PatientDashboardUpdate(CamelModel):
    name: dict | str | None = None
    description: dict | str | None = None
    show_widget_titles: bool | None = None
    widget_spacing: int | None = None
    fit_to_height: bool | None = None
    display_order: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    version: str | None = None
    # Restored on import/clone so the original creation date survives a git
    # round-trip; a normal PATCH never sends it (exclude_unset leaves it alone).
    created_at: datetime | None = None


class PatientDashboardResponse(CamelModel):
    id: str
    project_uid: str
    name: dict | str
    description: dict | str | None = None
    show_widget_titles: bool | None = None
    widget_spacing: int | None = None
    fit_to_height: bool | None = None
    display_order: int
    origin: str
    created_by_id: int | None = None
    created_by: str | None = None
    created_by_details: dict | None = None
    created_at: datetime
    updated_at: datetime
    version: str


class PatientDashboardTabCreate(CamelModel):
    id: str
    patient_dashboard_id: str
    name: dict | str = {}
    description: dict | str | None = None
    display_order: int = 0


class PatientDashboardTabUpdate(CamelModel):
    name: dict | str | None = None
    description: dict | str | None = None
    display_order: int | None = None


class PatientDashboardTabResponse(CamelModel):
    id: str
    patient_dashboard_id: str
    name: dict | str
    description: dict | str | None = None
    display_order: int


class PatientDashboardWidgetCreate(CamelModel):
    id: str
    tab_id: str
    name: dict | str = {}
    description: dict | str | None = None
    layout: dict = {}
    plugin_id: str
    language: str | None = None
    config: dict = {}
    plugin_version: str | None = None


class PatientDashboardWidgetUpdate(CamelModel):
    name: dict | str | None = None
    description: dict | str | None = None
    layout: dict | None = None
    plugin_id: str | None = None
    language: str | None = None
    config: dict | None = None
    plugin_version: str | None = None


class PatientDashboardWidgetResponse(CamelModel):
    id: str
    tab_id: str
    name: dict | str
    description: dict | str | None = None
    layout: dict
    plugin_id: str
    language: str | None = None
    config: dict
    plugin_version: str | None = None
