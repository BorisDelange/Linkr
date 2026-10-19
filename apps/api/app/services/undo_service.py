"""Undo one change an external client (an agent over MCP) made.

Each recorded change carries what reverses it: `delete` what it created,
`restore` the fields it overwrote, or `recreate` what it deleted — from a snapshot
taken just before the write — and a `guard`: what the item looked like right
after the write. Undo is refused (409) when the item no longer matches it, so a
later edit — from the app's own UI or another user, which leave no notification
— is never overwritten, and a creation is not undone once something was put in
it (the delete would cascade to it).
"""
import hashlib
import json
from pathlib import Path

from fastapi import HTTPException, status
from fastapi.encoders import jsonable_encoder
from sqlalchemy import inspect
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


# --- Undo payloads (built by the routes right after they write) ------------

# A snapshot lives in the notification row: past this size a change is still
# notified but cannot be undone (mapping exports can weigh megabytes).
MAX_UNDO_CHARS = 1_000_000

# Never compared: timestamps move with any write, and these only record a run's
# outcome or an order a reorder rewrites — a run after a creation is no edit.
_UNGUARDED = {
    "updated_at", "created_at", "result_count", "attrition", "materialization",
    "status", "last_run_at", "last_run_duration_ms", "order",
}


def _state(row) -> dict:
    return jsonable_encoder({a.key: getattr(row, a.key) for a in inspect(row).mapper.column_attrs})


def _digest(values: dict) -> str:
    return hashlib.sha256(json.dumps(values, sort_keys=True, default=str).encode()).hexdigest()


def _created_digest(row) -> str:
    return _digest({k: v for k, v in _state(row).items() if k not in _UNGUARDED})


def _fits(snapshot: dict) -> bool:
    return len(json.dumps(snapshot, default=str)) <= MAX_UNDO_CHARS


def created(kind: str, row) -> dict:
    """Undo a creation: delete the row, while it still is as created and empty."""
    return {"kind": kind, "op": "delete", "id": row.id, "guard": _created_digest(row)}


def updated(kind: str, row, before: dict) -> dict | None:
    """Undo an update: write `before` back, while the fields the write changed
    still hold what it wrote. None when nothing changed or the snapshot is too big."""
    before = jsonable_encoder(before)
    after = _state(row)
    fields = sorted(k for k in before if k not in ("updated_at", "created_at") and before[k] != after.get(k))
    if not fields or not _fits(before):
        return None
    return {
        "kind": kind, "op": "restore", "id": row.id, "snapshot": before,
        "guard": {"fields": fields, "digest": _digest({k: after.get(k) for k in fields})},
    }


def deleted(kind: str, row_id: str, snapshot: dict) -> dict | None:
    """Undo a deletion: recreate from `snapshot`, while nothing took its id."""
    snapshot = jsonable_encoder(snapshot)
    if not _fits(snapshot):
        return None
    return {"kind": kind, "op": "recreate", "id": row_id, "snapshot": snapshot, "guard": "absent"}


def final(kind: str, row_id: str) -> dict:
    """A change that cannot be undone but ends the item: older changes to it
    stop being undoable (see `notification_service.list_for_user`)."""
    return {"kind": kind, "op": "none", "id": row_id}


def dataset_created(path: str, file: Path) -> dict:
    st = file.stat()
    return {"kind": "dataset", "op": "delete", "id": path, "guard": f"{st.st_size}:{st.st_mtime_ns}"}


def is_guarded(undo: dict | None) -> bool:
    """Whether an undo can be applied: a payload recorded before guards existed
    could overwrite a later edit, so it is not."""
    return bool(undo) and undo.get("op") != "none" and "guard" in undo


def _conflict(code: str, message: str) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, {"code": code, "message": message})


def _gone(kind: str) -> HTTPException:
    return _conflict("gone", f"The {kind.replace('_', ' ')} no longer exists")


def _require_unchanged(undo: dict, row) -> None:
    guard = undo["guard"]
    if undo["op"] == "delete":
        same = guard == _created_digest(row)
    else:
        state = _state(row)
        same = guard["digest"] == _digest({k: state.get(k) for k in guard["fields"]})
    if not same:
        raise _conflict("changed", "Changed since; undoing would overwrite that change")


def _require_empty(children: list) -> None:
    if children:
        raise _conflict("not_empty", "Something was added to it since; undo or delete that first")


def _require_absent(existing) -> None:
    if existing is not None:
        raise _conflict("exists", "Something with the same id exists again")


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
    if not is_guarded(undo):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This change cannot be undone")

    if kind == "cohort":
        # A cohort may belong to a database rather than a project: check against
        # whichever owns it, as the cohort routes do.
        if op == "recreate":
            await cohort_access.require_owner_access(
                db, snap.get("project_uid"), snap.get("owner_data_source_id"), user, "cohorts:write",
            )
            _require_absent(await cohort_service.get(db, target))
            await cohort_service.create(db, CohortCreate(**_fields(snap, CohortCreate)))
            return False
        cohort = await cohort_service.get(db, target)
        if cohort is None:
            raise _gone(kind)
        permission = "cohorts:delete" if op == "delete" else "cohorts:write"
        await cohort_access.require_owner_access(
            db, cohort.project_uid, cohort.owner_data_source_id, user, permission,
        )
        _require_unchanged(undo, cohort)
        if op == "delete":
            await cohort_service.delete(db, cohort)
            return True
        await cohort_service.update(db, cohort, CohortUpdate(**_fields(snap, CohortUpdate)))
        return False

    if kind == "dashboard":
        if op == "recreate":
            await _require(db, project_uid, user, "dashboards:write")
            _require_absent(await dashboard_service.get(db, target))
            await dashboard_service.create(db, DashboardCreate(**_fields(snap, DashboardCreate)))
            for tab in snap.get("tabs", []):
                await _recreate_tab(db, tab)
            return False
        dashboard = await dashboard_service.get(db, target)
        if dashboard is None:
            raise _gone(kind)
        await _require(db, project_uid, user, "dashboards:delete" if op == "delete" else "dashboards:write")
        _require_unchanged(undo, dashboard)
        if op == "delete":
            _require_empty(await dashboard_service.list_tabs(db, dashboard.id))
            await dashboard_service.delete(db, dashboard)
            return True
        await dashboard_service.update(db, dashboard, DashboardUpdate(**_fields(snap, DashboardUpdate)))
        return False

    if kind in ("tab", "widget"):
        await _require(db, project_uid, user, "dashboards:delete" if op == "delete" else "dashboards:write")
        get = dashboard_service.get_tab if kind == "tab" else dashboard_service.get_widget
        if op == "recreate":
            _require_absent(await get(db, target))
            if kind == "tab":
                await _recreate_tab(db, snap)
            else:
                await dashboard_service.create_widget(db, DashboardWidgetCreate(**_fields(snap, DashboardWidgetCreate)))
            return False
        row = await get(db, target)
        if row is None:
            raise _gone(kind)
        _require_unchanged(undo, row)
        if op == "delete":
            if kind == "tab":
                _require_empty(await dashboard_service.list_widgets(db, row.id))
            await (dashboard_service.delete_tab if kind == "tab" else dashboard_service.delete_widget)(db, row)
        elif kind == "tab":
            await dashboard_service.update_tab(db, row, DashboardTabUpdate(**_fields(snap, DashboardTabUpdate)))
        else:
            await dashboard_service.update_widget(db, row, DashboardWidgetUpdate(**_fields(snap, DashboardWidgetUpdate)))
        return False

    if kind == "etl_pipeline":
        pipeline = await etl_pipeline_service.get(db, target)
        if pipeline is None:
            raise _gone(kind)
        await check_workspace_permission(db, pipeline.workspace_id, user, "etl:delete" if op == "delete" else "etl:write")
        _require_unchanged(undo, pipeline)
        if op == "delete":
            # Its scripts would go with it (FK cascade), whoever wrote them.
            _require_empty(await etl_pipeline_service.list_files(db, pipeline.id))
            await etl_pipeline_service.delete(db, pipeline)
            return True
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
                raise _gone("file")
            pipeline_id = node.pipeline_id
        pipeline = await etl_pipeline_service.get(db, pipeline_id) if pipeline_id else None
        if pipeline is None:
            raise _gone("pipeline")
        await check_workspace_permission(db, pipeline.workspace_id, user, "etl:delete" if op == "delete" else "etl:write")
        if op == "recreate":
            # File ids derive from the path: the same path re-created takes the same id.
            _require_absent(await etl_pipeline_service.get_file(db, target))
            await etl_pipeline_service.create_file(db, EtlFileCreate(**_fields(snap, EtlFileCreate)))
            return False
        _require_unchanged(undo, node)
        if op == "delete":
            files = await etl_pipeline_service.list_files(db, pipeline.id)
            _require_empty([f for f in files if f.parent_id == node.id])
            await etl_pipeline_service.delete_file(db, node)
        else:
            await etl_pipeline_service.update_file(db, node, EtlFileUpdate(**_fields(snap, EtlFileUpdate)))
        return False

    if kind == "dataset" and op == "delete":
        await _require(db, project_uid, user, "datasets:delete")
        file = project_fs.dataset_path(project_uid, target)
        if not file.exists():
            raise _gone(kind)
        st = file.stat()
        if undo["guard"] != f"{st.st_size}:{st.st_mtime_ns}":
            raise _conflict("changed", "Changed since; undoing would overwrite that change")
        file.unlink()
        return True

    raise HTTPException(status.HTTP_400_BAD_REQUEST, "This change cannot be undone")
