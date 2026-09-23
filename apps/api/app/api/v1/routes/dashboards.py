from types import SimpleNamespace

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_project_permission
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
from app.services import dashboard_service, notification_service, undo_service

router = APIRouter(prefix="/dashboards", tags=["dashboards"])


async def _require_project_access(
    db: AsyncSession, project_uid: str, user: User, permission: str
) -> None:
    """Dashboard access derives from the owning project (workspace role inherited,
    with per-project override applied)."""
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    await check_project_permission(db, project, user, permission)


async def _load_dashboard(
    db: AsyncSession, dashboard_id: str, user: User, permission: str
) -> Dashboard:
    dashboard = await dashboard_service.get(db, dashboard_id)
    if dashboard is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _require_project_access(db, dashboard.project_uid, user, permission)
    return dashboard


async def _load_tab(
    db: AsyncSession, tab_id: str, user: User, permission: str
) -> DashboardTab:
    tab = await dashboard_service.get_tab(db, tab_id)
    if tab is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _load_dashboard(db, tab.dashboard_id, user, permission)
    return tab


async def _load_widget(
    db: AsyncSession, widget_id: str, user: User, permission: str
) -> DashboardWidget:
    widget = await dashboard_service.get_widget(db, widget_id)
    if widget is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _load_tab(db, widget.tab_id, user, permission)
    return widget


async def _notify(
    db: AsyncSession, request: Request, user: User, dashboard: Dashboard | SimpleNamespace | None, action: str,
    part: str | None = None, part_action: str | None = None, part_name: dict | str | None = None,
    undo: dict | None = None,
) -> None:
    """Report an external client's change to the dashboard's owner tabs. A tab or
    widget change reads as the dashboard updated, with what moved inside it."""
    if dashboard is None:
        return
    detail = None
    if part is not None:
        detail = {
            "part": part, "action": part_action,
            "name": part_name if isinstance(part_name, dict) else {"en": part_name or ""},
        }
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request), action=action,
        entity_type="dashboard", entity_id=dashboard.id, project_uid=dashboard.project_uid,
        label=dashboard.name, detail=detail, undo=undo,
    )


# --- Dashboards -------------------------------------------------------------


@router.get("", response_model=list[DashboardResponse])
async def list_dashboards(
    project_uid: str = Query(alias="projectUid"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project_access(db, project_uid, user, "dashboards:read")
    return await dashboard_service.list_for_project(db, project_uid)


@router.post("", response_model=DashboardResponse, status_code=status.HTTP_201_CREATED)
async def create_dashboard(
    body: DashboardCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project_access(db, body.project_uid, user, "dashboards:write")
    dashboard = await dashboard_service.create(db, body)
    await _notify(db, request, user, dashboard, "created",
                  undo={"kind": "dashboard", "op": "delete", "id": dashboard.id})
    return dashboard


@router.get("/{dashboard_id}", response_model=DashboardResponse)
async def get_dashboard(
    dashboard_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load_dashboard(db, dashboard_id, user, "dashboards:read")


@router.patch("/{dashboard_id}", response_model=DashboardResponse)
async def update_dashboard(
    dashboard_id: str,
    body: DashboardUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    dashboard = await _load_dashboard(db, dashboard_id, user, "dashboards:write")
    before = DashboardResponse.model_validate(dashboard).model_dump(mode="json")
    dashboard = await dashboard_service.update(db, dashboard, body)
    await _notify(db, request, user, dashboard, "updated",
                  undo={"kind": "dashboard", "op": "restore", "id": dashboard.id, "snapshot": before})
    return dashboard


@router.delete("/{dashboard_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dashboard(
    dashboard_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    dashboard = await _load_dashboard(db, dashboard_id, user, "dashboards:delete")
    snapshot = SimpleNamespace(id=dashboard.id, project_uid=dashboard.project_uid, name=dashboard.name)
    before = await undo_service.dashboard_snapshot(db, dashboard)
    await dashboard_service.delete(db, dashboard)
    await _notify(db, request, user, snapshot, "deleted",
                  undo={"kind": "dashboard", "op": "recreate", "id": snapshot.id, "snapshot": before})


# --- Tabs -------------------------------------------------------------------


@router.get("/{dashboard_id}/tabs", response_model=list[DashboardTabResponse])
async def list_tabs(
    dashboard_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_dashboard(db, dashboard_id, user, "dashboards:read")
    return await dashboard_service.list_tabs(db, dashboard_id)


@router.post(
    "/tabs", response_model=DashboardTabResponse, status_code=status.HTTP_201_CREATED
)
async def create_tab(
    body: DashboardTabCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    dashboard = await _load_dashboard(db, body.dashboard_id, user, "dashboards:write")
    tab = await dashboard_service.create_tab(db, body)
    await _notify(db, request, user, dashboard, "updated", "tab", "created", tab.name,
                  undo={"kind": "tab", "op": "delete", "id": tab.id})
    return tab


@router.get("/tabs/{tab_id}", response_model=DashboardTabResponse)
async def get_tab(
    tab_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load_tab(db, tab_id, user, "dashboards:read")


@router.patch("/tabs/{tab_id}", response_model=DashboardTabResponse)
async def update_tab(
    tab_id: str,
    body: DashboardTabUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    tab = await _load_tab(db, tab_id, user, "dashboards:write")
    before = DashboardTabResponse.model_validate(tab).model_dump(mode="json")
    tab = await dashboard_service.update_tab(db, tab, body)
    dashboard = await dashboard_service.get(db, tab.dashboard_id)
    await _notify(db, request, user, dashboard, "updated", "tab", "updated", tab.name,
                  undo={"kind": "tab", "op": "restore", "id": tab.id, "snapshot": before})
    return tab


@router.delete("/tabs/{tab_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tab(
    tab_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    tab = await _load_tab(db, tab_id, user, "dashboards:delete")
    dashboard_id, name, tab_id = tab.dashboard_id, tab.name, tab.id
    before = await undo_service.tab_snapshot(db, tab)
    await dashboard_service.delete_tab(db, tab)
    dashboard = await dashboard_service.get(db, dashboard_id)
    await _notify(db, request, user, dashboard, "updated", "tab", "deleted", name,
                  undo={"kind": "tab", "op": "recreate", "id": tab_id, "snapshot": before})


@router.delete(
    "/{dashboard_id}/tabs", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_tabs_for_dashboard(
    dashboard_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_dashboard(db, dashboard_id, user, "dashboards:delete")
    await dashboard_service.delete_tabs_for_dashboard(db, dashboard_id)


# --- Widgets ----------------------------------------------------------------


@router.get("/tabs/{tab_id}/widgets", response_model=list[DashboardWidgetResponse])
async def list_widgets(
    tab_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_tab(db, tab_id, user, "dashboards:read")
    return await dashboard_service.list_widgets(db, tab_id)


@router.post(
    "/widgets",
    response_model=DashboardWidgetResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_widget(
    body: DashboardWidgetCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    tab = await _load_tab(db, body.tab_id, user, "dashboards:write")
    widget = await dashboard_service.create_widget(db, body)
    dashboard = await dashboard_service.get(db, tab.dashboard_id)
    await _notify(db, request, user, dashboard, "updated", "widget", "created", widget.name,
                  undo={"kind": "widget", "op": "delete", "id": widget.id})
    return widget


@router.get("/widgets/{widget_id}", response_model=DashboardWidgetResponse)
async def get_widget(
    widget_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load_widget(db, widget_id, user, "dashboards:read")


@router.patch("/widgets/{widget_id}", response_model=DashboardWidgetResponse)
async def update_widget(
    widget_id: str,
    body: DashboardWidgetUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    widget = await _load_widget(db, widget_id, user, "dashboards:write")
    before = undo_service.widget_snapshot(widget)
    widget = await dashboard_service.update_widget(db, widget, body)
    tab = await dashboard_service.get_tab(db, widget.tab_id)
    dashboard = await dashboard_service.get(db, tab.dashboard_id) if tab else None
    await _notify(db, request, user, dashboard, "updated", "widget", "updated", widget.name,
                  undo={"kind": "widget", "op": "restore", "id": widget.id, "snapshot": before})
    return widget


@router.delete("/widgets/{widget_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_widget(
    widget_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    widget = await _load_widget(db, widget_id, user, "dashboards:delete")
    tab = await dashboard_service.get_tab(db, widget.tab_id)
    name = widget.name
    before = undo_service.widget_snapshot(widget)
    await dashboard_service.delete_widget(db, widget)
    dashboard = await dashboard_service.get(db, tab.dashboard_id) if tab else None
    await _notify(db, request, user, dashboard, "updated", "widget", "deleted", name,
                  undo={"kind": "widget", "op": "recreate", "id": before["id"], "snapshot": before})


@router.delete("/tabs/{tab_id}/widgets", status_code=status.HTTP_204_NO_CONTENT)
async def delete_widgets_for_tab(
    tab_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_tab(db, tab_id, user, "dashboards:delete")
    await dashboard_service.delete_widgets_for_tab(db, tab_id)
