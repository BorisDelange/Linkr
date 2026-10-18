"""Undo one change an external client (an agent over MCP) made.

Each recorded change carries what reverses it: `delete` what it created,
`restore` the fields it overwrote, or `recreate` what it deleted — from a snapshot
taken just before the write. Undo is offered only on the latest change to a given
item (see `notification_service.list_for_user`), so it never overwrites a later
edit made on top of it.
"""
from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.permissions import check_project_permission, check_workspace_permission
from app.models.project import Project
from app.models.user import User
from app.schemas.cohort import CohortCreate, CohortResponse, CohortUpdate
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
from app.schemas.etl_pipeline import EtlFileCreate, EtlFileUpdate, EtlPipelineUpdate
from app.services import (
    cohort_access,
    cohort_service,
    dashboard_service,
    etl_pipeline_service,
    project_fs,
)

# --- Snapshots (taken by the routes before they write) ----------------------


def cohort_snapshot(cohort) -> dict:
    # Not what the server derives from the cohort: undoing an edit must not erase
    # a later derivation's record, and a frozen membership is a whole id list.
    return CohortResponse.model_validate(cohort).model_dump(mode="json", exclude={"derivations", "materialization"})


def widget_snapshot(widget) -> dict:
    return DashboardWidgetResponse.model_validate(widget).model_dump(mode="json")


async def tab_snapshot(db: AsyncSession, tab) -> dict:
    widgets = await dashboard_service.list_widgets(db, tab.id)
    return {
        **DashboardTabResponse.model_validate(tab).model_dump(mode="json"),
        "widgets": [widget_snapshot(w) for w in widgets],
    }


async def dashboard_snapshot(db: AsyncSession, dashboard) -> dict:
    tabs = await dashboard_service.list_tabs(db, dashboard.id)
    return {
        **DashboardResponse.model_validate(dashboard).model_dump(mode="json"),
        "tabs": [await tab_snapshot(db, t) for t in tabs],
    }


def _fields(snapshot: dict, model) -> dict:
    """The snapshot's values the given schema accepts — a response carries
    server-owned fields (updated_at…) the create/update schemas do not take."""
    return {k: v for k, v in snapshot.items() if k in model.model_fields}


# --- Apply ------------------------------------------------------------------


async def _require(db: AsyncSession, project_uid: str | None, user: User, permission: str) -> None:
    project = await db.get(Project, project_uid) if project_uid else None
    if project is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "The project no longer exists")
    await check_project_permission(db, project, user, permission)


async def _recreate_tab(db: AsyncSession, snap: dict) -> None:
    await dashboard_service.create_tab(db, DashboardTabCreate(**_fields(snap, DashboardTabCreate)))
    for w in snap.get("widgets", []):
        await dashboard_service.create_widget(db, DashboardWidgetCreate(**_fields(w, DashboardWidgetCreate)))


async def apply(db: AsyncSession, user: User, project_uid: str | None, undo: dict) -> bool:
    """Reverse one change. Returns True when the entity it concerns is now gone
    (the open tab must drop it rather than re-read it)."""
    kind, op, target, snap = undo["kind"], undo["op"], undo["id"], undo.get("snapshot") or {}

    if kind == "cohort":
        # A cohort may belong to a database rather than a project: check against
        # whichever owns it, as the cohort routes do.
        if op == "recreate":
            await cohort_access.require_owner_access(
                db, snap.get("project_uid"), snap.get("owner_data_source_id"), user, "cohorts:write",
            )
            await cohort_service.create(db, CohortCreate(**_fields(snap, CohortCreate)))
            return False
        cohort = await cohort_service.get(db, target)
        if cohort is None:
            raise HTTPException(status.HTTP_409_CONFLICT, "The cohort no longer exists")
        permission = "cohorts:delete" if op == "delete" else "cohorts:write"
        await cohort_access.require_owner_access(
            db, cohort.project_uid, cohort.owner_data_source_id, user, permission,
        )
        if op == "delete":
            await cohort_service.delete(db, cohort)
            return True
        await cohort_service.update(db, cohort, CohortUpdate(**_fields(snap, CohortUpdate)))
        return False

    if kind == "dashboard":
        if op == "recreate":
            await _require(db, project_uid, user, "dashboards:write")
            await dashboard_service.create(db, DashboardCreate(**_fields(snap, DashboardCreate)))
            for tab in snap.get("tabs", []):
                await _recreate_tab(db, tab)
            return False
        dashboard = await dashboard_service.get(db, target)
        if dashboard is None:
            raise HTTPException(status.HTTP_409_CONFLICT, "The dashboard no longer exists")
        if op == "delete":
            await _require(db, project_uid, user, "dashboards:delete")
            await dashboard_service.delete(db, dashboard)
            return True
        await _require(db, project_uid, user, "dashboards:write")
        await dashboard_service.update(db, dashboard, DashboardUpdate(**_fields(snap, DashboardUpdate)))
        return False

    if kind in ("tab", "widget"):
        await _require(db, project_uid, user, "dashboards:delete" if op == "delete" else "dashboards:write")
        if op == "recreate":
            if kind == "tab":
                await _recreate_tab(db, snap)
            else:
                await dashboard_service.create_widget(db, DashboardWidgetCreate(**_fields(snap, DashboardWidgetCreate)))
            return False
        row = await (dashboard_service.get_tab if kind == "tab" else dashboard_service.get_widget)(db, target)
        if row is None:
            raise HTTPException(status.HTTP_409_CONFLICT, f"The {kind} no longer exists")
        if op == "delete":
            await (dashboard_service.delete_tab if kind == "tab" else dashboard_service.delete_widget)(db, row)
        elif kind == "tab":
            await dashboard_service.update_tab(db, row, DashboardTabUpdate(**_fields(snap, DashboardTabUpdate)))
        else:
            await dashboard_service.update_widget(db, row, DashboardWidgetUpdate(**_fields(snap, DashboardWidgetUpdate)))
        return False

    if kind == "etl_pipeline":
        pipeline = await etl_pipeline_service.get(db, target)
        if pipeline is None:
            raise HTTPException(status.HTTP_409_CONFLICT, "The pipeline no longer exists")
        if op == "delete":
            await check_workspace_permission(db, pipeline.workspace_id, user, "etl:delete")
            await etl_pipeline_service.delete(db, pipeline)
            return True
        await check_workspace_permission(db, pipeline.workspace_id, user, "etl:write")
        await etl_pipeline_service.update(db, pipeline, EtlPipelineUpdate(**_fields(snap, EtlPipelineUpdate)))
        return False

    if kind == "etl_file":
        # The notification is about the pipeline, so whatever happens to the file
        # the pipeline is still there: never "gone".
        pipeline_id = snap.get("pipeline_id") if op == "recreate" else None
        node = None
        if op != "recreate":
            node = await etl_pipeline_service.get_file(db, target)
            if node is None:
                raise HTTPException(status.HTTP_409_CONFLICT, "The file no longer exists")
            pipeline_id = node.pipeline_id
        pipeline = await etl_pipeline_service.get(db, pipeline_id) if pipeline_id else None
        if pipeline is None:
            raise HTTPException(status.HTTP_409_CONFLICT, "The pipeline no longer exists")
        await check_workspace_permission(db, pipeline.workspace_id, user, "etl:delete" if op == "delete" else "etl:write")
        if op == "recreate":
            await etl_pipeline_service.create_file(db, EtlFileCreate(**_fields(snap, EtlFileCreate)))
        elif op == "delete":
            await etl_pipeline_service.delete_file(db, node)
        else:
            await etl_pipeline_service.update_file(db, node, EtlFileUpdate(**_fields(snap, EtlFileUpdate)))
        return False

    if kind == "dataset" and op == "delete":
        await _require(db, project_uid, user, "datasets:delete")
        project_fs.dataset_path(project_uid, target).unlink(missing_ok=True)
        return True

    raise HTTPException(status.HTTP_400_BAD_REQUEST, "This change cannot be undone")
