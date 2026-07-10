from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_project_role
from app.models.dashboard import Dashboard, DashboardTab, DashboardWidget
from app.models.project import Project
from app.models.user import User
from app.schemas.dashboard import (
    DashboardCreate,
    DashboardResponse,
    DashboardTabCreate,
    DashboardTabResponse,
    DashboardTabUpdate,
    DashboardUpdate,
    DashboardWidgetCreate,
    DashboardWidgetResponse,
    DashboardWidgetUpdate,
)
from app.services import dashboard_service

router = APIRouter(prefix="/dashboards", tags=["dashboards"])


async def _require_project_access(
    db: AsyncSession, project_uid: str, user: User, min_role: str
) -> None:
    """Dashboard access derives from the owning project (workspace role inherited,
    with per-project override applied)."""
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    await check_project_role(db, project, user, min_role)


async def _load_dashboard(
    db: AsyncSession, dashboard_id: str, user: User, min_role: str
) -> Dashboard:
    dashboard = await dashboard_service.get(db, dashboard_id)
    if dashboard is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _require_project_access(db, dashboard.project_uid, user, min_role)
    return dashboard


async def _load_tab(
    db: AsyncSession, tab_id: str, user: User, min_role: str
) -> DashboardTab:
    tab = await dashboard_service.get_tab(db, tab_id)
    if tab is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _load_dashboard(db, tab.dashboard_id, user, min_role)
    return tab


async def _load_widget(
    db: AsyncSession, widget_id: str, user: User, min_role: str
) -> DashboardWidget:
    widget = await dashboard_service.get_widget(db, widget_id)
    if widget is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _load_tab(db, widget.tab_id, user, min_role)
    return widget


# --- Dashboards -------------------------------------------------------------


@router.get("", response_model=list[DashboardResponse])
async def list_dashboards(
    project_uid: str = Query(alias="projectUid"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project_access(db, project_uid, user, "viewer")
    return await dashboard_service.list_for_project(db, project_uid)


@router.post("", response_model=DashboardResponse, status_code=status.HTTP_201_CREATED)
async def create_dashboard(
    body: DashboardCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project_access(db, body.project_uid, user, "editor")
    return await dashboard_service.create(db, body)


@router.get("/{dashboard_id}", response_model=DashboardResponse)
async def get_dashboard(
    dashboard_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load_dashboard(db, dashboard_id, user, "viewer")


@router.patch("/{dashboard_id}", response_model=DashboardResponse)
async def update_dashboard(
    dashboard_id: str,
    body: DashboardUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    dashboard = await _load_dashboard(db, dashboard_id, user, "editor")
    return await dashboard_service.update(db, dashboard, body)


@router.delete("/{dashboard_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dashboard(
    dashboard_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    dashboard = await _load_dashboard(db, dashboard_id, user, "editor")
    await dashboard_service.delete(db, dashboard)


# --- Tabs -------------------------------------------------------------------


@router.get("/{dashboard_id}/tabs", response_model=list[DashboardTabResponse])
async def list_tabs(
    dashboard_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_dashboard(db, dashboard_id, user, "viewer")
    return await dashboard_service.list_tabs(db, dashboard_id)


@router.post(
    "/tabs", response_model=DashboardTabResponse, status_code=status.HTTP_201_CREATED
)
async def create_tab(
    body: DashboardTabCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_dashboard(db, body.dashboard_id, user, "editor")
    return await dashboard_service.create_tab(db, body)


@router.get("/tabs/{tab_id}", response_model=DashboardTabResponse)
async def get_tab(
    tab_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load_tab(db, tab_id, user, "viewer")


@router.patch("/tabs/{tab_id}", response_model=DashboardTabResponse)
async def update_tab(
    tab_id: str,
    body: DashboardTabUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    tab = await _load_tab(db, tab_id, user, "editor")
    return await dashboard_service.update_tab(db, tab, body)


@router.delete("/tabs/{tab_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tab(
    tab_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    tab = await _load_tab(db, tab_id, user, "editor")
    await dashboard_service.delete_tab(db, tab)


@router.delete(
    "/{dashboard_id}/tabs", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_tabs_for_dashboard(
    dashboard_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_dashboard(db, dashboard_id, user, "editor")
    await dashboard_service.delete_tabs_for_dashboard(db, dashboard_id)


# --- Widgets ----------------------------------------------------------------


@router.get("/tabs/{tab_id}/widgets", response_model=list[DashboardWidgetResponse])
async def list_widgets(
    tab_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_tab(db, tab_id, user, "viewer")
    return await dashboard_service.list_widgets(db, tab_id)


@router.post(
    "/widgets",
    response_model=DashboardWidgetResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_widget(
    body: DashboardWidgetCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_tab(db, body.tab_id, user, "editor")
    return await dashboard_service.create_widget(db, body)


@router.get("/widgets/{widget_id}", response_model=DashboardWidgetResponse)
async def get_widget(
    widget_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load_widget(db, widget_id, user, "viewer")


@router.patch("/widgets/{widget_id}", response_model=DashboardWidgetResponse)
async def update_widget(
    widget_id: str,
    body: DashboardWidgetUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    widget = await _load_widget(db, widget_id, user, "editor")
    return await dashboard_service.update_widget(db, widget, body)


@router.delete("/widgets/{widget_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_widget(
    widget_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    widget = await _load_widget(db, widget_id, user, "editor")
    await dashboard_service.delete_widget(db, widget)


@router.delete("/tabs/{tab_id}/widgets", status_code=status.HTTP_204_NO_CONTENT)
async def delete_widgets_for_tab(
    tab_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_tab(db, tab_id, user, "editor")
    await dashboard_service.delete_widgets_for_tab(db, tab_id)
