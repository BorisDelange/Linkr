from types import SimpleNamespace

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_project_permission, check_workspace_permission
from app.models.cohort import Cohort
from app.models.data_source import DataSource
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
from app.services import notification_service, patient_dashboard_service

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


# A database's board is part of the database, as its cohorts are: reading it is
# reading the database, changing it is editing the database.
_DATABASE_PERMISSION = {
    "patient-data:read": "databases:read",
    "patient-data:write": "databases:write",
    "patient-data:delete": "databases:write",
}


async def _require_database_access(
    db: AsyncSession, data_source_id: str, user: User, permission: str
) -> None:
    source = await db.get(DataSource, data_source_id)
    if source is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Database not found")
    if source.workspace_id is not None:
        await check_workspace_permission(
            db, source.workspace_id, user, _DATABASE_PERMISSION[permission]
        )


async def _require_owner_access(
    db: AsyncSession,
    project_uid: str | None,
    owner_data_source_id: str | None,
    user: User,
    permission: str,
) -> None:
    if project_uid:
        await _require_project_access(db, project_uid, user, permission)
    elif owner_data_source_id:
        await _require_database_access(db, owner_data_source_id, user, permission)
    else:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")


async def _load_dashboard(
    db: AsyncSession, dashboard_id: str, user: User, permission: str
) -> PatientDashboard:
    dashboard = await patient_dashboard_service.get(db, dashboard_id)
    if dashboard is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _require_owner_access(
        db, dashboard.project_uid, dashboard.owner_data_source_id, user, permission
    )
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


# --- Notifications (writes by an external client, e.g. an agent over MCP) ---

# Ordering only (a reorder rewrites one row at a time): refresh, no notification.
_ORDER_FIELDS = {"display_order"}


def _previous(row, changes: dict) -> dict:
    """The values `changes` actually alters, as they were before the write."""
    return {k: getattr(row, k) for k, v in changes.items() if getattr(row, k) != v}


def _board_ref(board: PatientDashboard) -> SimpleNamespace:
    """What a notification needs of a board, kept before a delete expires the row."""
    return SimpleNamespace(
        id=board.id, name=board.name, project_uid=board.project_uid,
        owner_data_source_id=board.owner_data_source_id, owner_cohort_id=board.owner_cohort_id,
    )


async def _notify(
    db: AsyncSession, request: Request, user: User, board: PatientDashboard | SimpleNamespace | None, action: str,
    part: str | None = None, part_action: str | None = None, part_name: dict | str | None = None,
    *, notify: bool = True,
) -> None:
    """A tab or widget change reads as the board updated, with what moved inside
    it. A database's board has no project: its workspace and database travel in
    `detail`, as does the cohort a cohort's board belongs to."""
    if board is None:
        return
    detail: dict = {}
    if board.owner_data_source_id:
        source = await db.get(DataSource, board.owner_data_source_id)
        detail.update(workspaceId=source.workspace_id if source else None, dataSourceId=board.owner_data_source_id)
    if board.owner_cohort_id:
        detail["cohortId"] = board.owner_cohort_id
    if part is not None:
        detail.update(
            part=part, action=part_action,
            name=part_name if isinstance(part_name, dict) else {"en": part_name or ""},
        )
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request), action=action,
        entity_type="patient_board", entity_id=board.id, project_uid=board.project_uid,
        label=board.name, detail=detail or None, notify=notify,
    )


# --- Boards -----------------------------------------------------------------


@router.get("", response_model=list[PatientDashboardResponse])
async def list_dashboards(
    project_uid: str | None = Query(default=None, alias="projectUid"),
    data_source_id: str | None = Query(default=None, alias="dataSourceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if data_source_id is not None:
        await _require_database_access(db, data_source_id, user, "patient-data:read")
        return await patient_dashboard_service.list_for_database(db, data_source_id)
    if project_uid is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "projectUid or dataSourceId is required")
    await _require_project_access(db, project_uid, user, "patient-data:read")
    return await patient_dashboard_service.list_for_project(db, project_uid)


@router.post(
    "", response_model=PatientDashboardResponse, status_code=status.HTTP_201_CREATED
)
async def create_dashboard(
    body: PatientDashboardCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if bool(body.project_uid) == bool(body.owner_data_source_id):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "a patient board belongs to exactly one project or one database",
        )
    await _require_owner_access(
        db, body.project_uid, body.owner_data_source_id, user, "patient-data:write"
    )
    if body.owner_data_source_id:
        # A database's boards are its cohorts': one each, the lens that cohort's
        # patients are reviewed through.
        cohort = await db.get(Cohort, body.owner_cohort_id) if body.owner_cohort_id else None
        if cohort is None or cohort.owner_data_source_id != body.owner_data_source_id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "a database's patient board belongs to one of its cohorts"
            )
        boards = await patient_dashboard_service.list_for_database(db, body.owner_data_source_id)
        if any(b.owner_cohort_id == cohort.id for b in boards):
            raise HTTPException(status.HTTP_409_CONFLICT, "this cohort already has its patient board")
        body.data_source_id = body.owner_data_source_id
    elif body.owner_cohort_id:
        # A project cohort's board: its own, not one of the project's boards —
        # one per cohort, reading the database the cohort runs on.
        cohort = await db.get(Cohort, body.owner_cohort_id)
        if cohort is None or cohort.project_uid != body.project_uid:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "a project's cohort board belongs to one of its cohorts"
            )
        boards = await patient_dashboard_service.list_for_project(db, body.project_uid)
        if any(b.owner_cohort_id == cohort.id for b in boards):
            raise HTTPException(status.HTTP_409_CONFLICT, "this cohort already has its patient board")
        body.data_source_id = cohort.data_source_id or body.data_source_id
    board = await patient_dashboard_service.create(db, body)
    await _notify(db, request, user, board, "created")
    return board


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
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    dashboard = await _load_dashboard(db, dashboard_id, user, "patient-data:write")
    before = _previous(dashboard, body.model_dump(exclude_unset=True))
    dashboard = await patient_dashboard_service.update(db, dashboard, body)
    if before:
        await _notify(db, request, user, dashboard, "updated", notify=not before.keys() <= _ORDER_FIELDS)
    return dashboard


@router.delete("/{dashboard_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dashboard(
    dashboard_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    dashboard = await _load_dashboard(db, dashboard_id, user, "patient-data:delete")
    ref = _board_ref(dashboard)
    await patient_dashboard_service.delete(db, dashboard)
    await _notify(db, request, user, ref, "deleted")


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
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    dashboard = await _load_dashboard(db, body.patient_dashboard_id, user, "patient-data:write")
    tab = await patient_dashboard_service.create_tab(db, body)
    await _notify(db, request, user, dashboard, "updated", "tab", "created", tab.name)
    return tab


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
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    tab = await _load_tab(db, tab_id, user, "patient-data:write")
    before = _previous(tab, body.model_dump(exclude_unset=True))
    tab = await patient_dashboard_service.update_tab(db, tab, body)
    if before:
        dashboard = await patient_dashboard_service.get(db, tab.patient_dashboard_id)
        await _notify(db, request, user, dashboard, "updated", "tab", "updated", tab.name,
                      notify=not before.keys() <= _ORDER_FIELDS)
    return tab


@router.delete("/tabs/{tab_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tab(
    tab_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    tab = await _load_tab(db, tab_id, user, "patient-data:delete")
    dashboard_id, name = tab.patient_dashboard_id, tab.name
    await patient_dashboard_service.delete_tab(db, tab)
    dashboard = await patient_dashboard_service.get(db, dashboard_id)
    await _notify(db, request, user, dashboard, "updated", "tab", "deleted", name)


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
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    tab = await _load_tab(db, body.tab_id, user, "patient-data:write")
    widget = await patient_dashboard_service.create_widget(db, body)
    dashboard = await patient_dashboard_service.get(db, tab.patient_dashboard_id)
    await _notify(db, request, user, dashboard, "updated", "widget", "created", widget.name)
    return widget


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
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    widget = await _load_widget(db, widget_id, user, "patient-data:write")
    if "tab_id" in body.model_fields_set and body.tab_id is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A widget always belongs to a tab")
    if body.tab_id is not None and body.tab_id != widget.tab_id:
        source = await patient_dashboard_service.get_tab(db, widget.tab_id)
        target = await _load_tab(db, body.tab_id, user, "patient-data:write")
        if source is None or target.patient_dashboard_id != source.patient_dashboard_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "A widget can only move to a tab of its own board")
    before = _previous(widget, body.model_dump(exclude_unset=True))
    widget = await patient_dashboard_service.update_widget(db, widget, body)
    if before:
        tab = await patient_dashboard_service.get_tab(db, widget.tab_id)
        dashboard = await patient_dashboard_service.get(db, tab.patient_dashboard_id) if tab else None
        await _notify(db, request, user, dashboard, "updated", "widget", "updated", widget.name)
    return widget


@router.delete("/widgets/{widget_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_widget(
    widget_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    widget = await _load_widget(db, widget_id, user, "patient-data:delete")
    tab = await patient_dashboard_service.get_tab(db, widget.tab_id)
    name = widget.name
    await patient_dashboard_service.delete_widget(db, widget)
    dashboard = await patient_dashboard_service.get(db, tab.patient_dashboard_id) if tab else None
    await _notify(db, request, user, dashboard, "updated", "widget", "deleted", name)


@router.delete("/tabs/{tab_id}/widgets", status_code=status.HTTP_204_NO_CONTENT)
async def delete_widgets_for_tab(
    tab_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _load_tab(db, tab_id, user, "patient-data:delete")
    await patient_dashboard_service.delete_widgets_for_tab(db, tab_id)
