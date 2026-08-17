from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_project_permission
from app.models.patient_dashboard import (
    PatientDashboard,
    PatientDashboardTab,
    PatientDashboardWidget,
)
from app.models.project import Project
from app.models.user import User
from app.schemas.patient_dashboard import (
    PatientDashboardCreate,
    PatientDashboardResponse,
    PatientDashboardTabCreate,
    PatientDashboardTabResponse,
    PatientDashboardTabUpdate,
    PatientDashboardUpdate,
    PatientDashboardWidgetCreate,
    PatientDashboardWidgetResponse,
    PatientDashboardWidgetUpdate,
)
from app.services import patient_dashboard_service

router = APIRouter(prefix="/patient-dashboards", tags=["patient-dashboards"])


async def _require_project_access(
    db: AsyncSession, project_uid: str, user: User, permission: str
) -> None:
    """Board access derives from the owning project (workspace role inherited,
    with per-project override applied)."""
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    await check_project_permission(db, project, user, permission)


async def _load_dashboard(
    db: AsyncSession, dashboard_id: str, user: User, permission: str
) -> PatientDashboard:
    dashboard = await patient_dashboard_service.get(db, dashboard_id)
    if dashboard is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _require_project_access(db, dashboard.project_uid, user, permission)
    return dashboard


async def _load_tab(
    db: AsyncSession, tab_id: str, user: User, permission: str
) -> PatientDashboardTab:
    tab = await patient_dashboard_service.get_tab(db, tab_id)
    if tab is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _load_dashboard(db, tab.patient_dashboard_id, user, permission)
    return tab


async def _load_widget(
    db: AsyncSession, widget_id: str, user: User, permission: str
) -> PatientDashboardWidget:
    widget = await patient_dashboard_service.get_widget(db, widget_id)
    if widget is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _load_tab(db, widget.tab_id, user, permission)
    return widget


# --- Boards -----------------------------------------------------------------


@router.get("", response_model=list[PatientDashboardResponse])
async def list_dashboards(
    project_uid: str = Query(alias="projectUid"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project_access(db, project_uid, user, "patient-data:read")
    return await patient_dashboard_service.list_for_project(db, project_uid)


@router.post(
    "", response_model=PatientDashboardResponse, status_code=status.HTTP_201_CREATED
)
async def create_dashboard(
    body: PatientDashboardCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project_access(db, body.project_uid, user, "patient-data:write")
    return await patient_dashboard_service.create(db, body)


@router.get("/{dashboard_id}", response_model=PatientDashboardResponse)
async def get_dashboard(
    dashboard_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load_dashboard(db, dashboard_id, user, "patient-data:read")


@router.patch("/{dashboard_id}", response_model=PatientDashboardResponse)
async def update_dashboard(
    dashboard_id: str,
    body: PatientDashboardUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    dashboard = await _load_dashboard(db, dashboard_id, user, "patient-data:write")
    return await patient_dashboard_service.update(db, dashboard, body)


@router.delete("/{dashboard_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dashboard(
    dashboard_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    dashboard = await _load_dashboard(db, dashboard_id, user, "patient-data:delete")
    await patient_dashboard_service.delete(db, dashboard)


# --- Tabs -------------------------------------------------------------------


@router.get("/{dashboard_id}/tabs", response_model=list[PatientDashboardTabResponse])
async def list_tabs(
    dashboard_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_dashboard(db, dashboard_id, user, "patient-data:read")
    return await patient_dashboard_service.list_tabs(db, dashboard_id)


@router.post(
    "/tabs",
    response_model=PatientDashboardTabResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_tab(
    body: PatientDashboardTabCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_dashboard(db, body.patient_dashboard_id, user, "patient-data:write")
    return await patient_dashboard_service.create_tab(db, body)


@router.get("/tabs/{tab_id}", response_model=PatientDashboardTabResponse)
async def get_tab(
    tab_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load_tab(db, tab_id, user, "patient-data:read")


@router.patch("/tabs/{tab_id}", response_model=PatientDashboardTabResponse)
async def update_tab(
    tab_id: str,
    body: PatientDashboardTabUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    tab = await _load_tab(db, tab_id, user, "patient-data:write")
    return await patient_dashboard_service.update_tab(db, tab, body)


@router.delete("/tabs/{tab_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tab(
    tab_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    tab = await _load_tab(db, tab_id, user, "patient-data:delete")
    await patient_dashboard_service.delete_tab(db, tab)


@router.delete("/{dashboard_id}/tabs", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tabs_for_dashboard(
    dashboard_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_dashboard(db, dashboard_id, user, "patient-data:delete")
    await patient_dashboard_service.delete_tabs_for_dashboard(db, dashboard_id)


# --- Widgets ----------------------------------------------------------------


@router.get(
    "/tabs/{tab_id}/widgets", response_model=list[PatientDashboardWidgetResponse]
)
async def list_widgets(
    tab_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_tab(db, tab_id, user, "patient-data:read")
    return await patient_dashboard_service.list_widgets(db, tab_id)


@router.post(
    "/widgets",
    response_model=PatientDashboardWidgetResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_widget(
    body: PatientDashboardWidgetCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_tab(db, body.tab_id, user, "patient-data:write")
    return await patient_dashboard_service.create_widget(db, body)


@router.get("/widgets/{widget_id}", response_model=PatientDashboardWidgetResponse)
async def get_widget(
    widget_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load_widget(db, widget_id, user, "patient-data:read")


@router.patch("/widgets/{widget_id}", response_model=PatientDashboardWidgetResponse)
async def update_widget(
    widget_id: str,
    body: PatientDashboardWidgetUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    widget = await _load_widget(db, widget_id, user, "patient-data:write")
    return await patient_dashboard_service.update_widget(db, widget, body)


@router.delete("/widgets/{widget_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_widget(
    widget_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    widget = await _load_widget(db, widget_id, user, "patient-data:delete")
    await patient_dashboard_service.delete_widget(db, widget)


@router.delete("/tabs/{tab_id}/widgets", status_code=status.HTTP_204_NO_CONTENT)
async def delete_widgets_for_tab(
    tab_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_tab(db, tab_id, user, "patient-data:delete")
    await patient_dashboard_service.delete_widgets_for_tab(db, tab_id)
