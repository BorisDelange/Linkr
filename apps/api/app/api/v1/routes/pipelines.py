from types import SimpleNamespace

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_project_permission
from app.models.pipeline import Pipeline
from app.models.project import Project
from app.models.user import User
from app.schemas.pipeline import PipelineCreate, PipelineResponse, PipelineUpdate
from app.services import notification_service, pipeline_service

router = APIRouter(prefix="/pipelines", tags=["pipelines"])


async def _require_project_access(
    db: AsyncSession, project_uid: str, user: User, permission: str
) -> None:
    """Pipeline access derives from the owning project (workspace role inherited,
    with per-project override applied)."""
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    await check_project_permission(db, project, user, permission)


async def _load(
    db: AsyncSession, pipeline_id: str, user: User, permission: str
) -> Pipeline:
    pipeline = await pipeline_service.get(db, pipeline_id)
    if pipeline is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _require_project_access(db, pipeline.project_uid, user, permission)
    return pipeline


# --- Notifications (writes by an external client, e.g. an agent over MCP) ---

# What a run writes on a node (its outcome): the open diagram refreshes, the bell
# stays quiet.
_NODE_RUN_FIELDS = {"status", "rowCount", "columnCount", "error"}


def _node_edit(node: dict) -> dict:
    data = {k: v for k, v in (node.get("data") or {}).items() if k not in _NODE_RUN_FIELDS}
    return {**node, "data": data}


def _node_changes(before: list, after: list) -> tuple[list[tuple[str, dict]], bool]:
    """(action, node) for each node added, removed or edited, and whether
    anything at all changed on the nodes (a run's outcome included)."""
    old = {n.get("id"): n for n in before if isinstance(n, dict)}
    new = {n.get("id"): n for n in after if isinstance(n, dict)}
    changes = [("created", new[i]) for i in new.keys() - old.keys()]
    changes += [("deleted", old[i]) for i in old.keys() - new.keys()]
    changes += [
        ("updated", new[i]) for i in new.keys() & old.keys() if _node_edit(new[i]) != _node_edit(old[i])
    ]
    return changes, any(old.get(i) != new.get(i) for i in old.keys() | new.keys())


async def _notify(
    db: AsyncSession, request: Request, user: User, pipeline: Pipeline | SimpleNamespace, action: str,
    node: tuple[str, dict] | None = None, *, notify: bool = True,
) -> None:
    """A change to a project's pipeline; with `node` = (action, node), the one node
    it touched. Labelled with the pipeline's name, else the project's."""
    label = pipeline.name if any((pipeline.name or {}).values()) else None
    if label is None:
        project = await db.get(Project, pipeline.project_uid)
        label = project.name if project else None
    detail = None
    if node is not None:
        node_action, data = node
        detail = {"part": "node", "action": node_action, "name": {"en": str((data.get("data") or {}).get("label") or "")}}
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request), action=action,
        entity_type="project_pipeline", entity_id=pipeline.id, project_uid=pipeline.project_uid,
        label=label, detail=detail, notify=notify,
    )


@router.get("", response_model=list[PipelineResponse])
async def list_pipelines(
    project_uid: str | None = Query(default=None, alias="projectUid"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if project_uid is not None:
        await _require_project_access(db, project_uid, user, "pipeline:read")
        return await pipeline_service.list_for_project(db, project_uid)
    return await pipeline_service.list_for_user(db, user)


@router.post("", response_model=PipelineResponse, status_code=status.HTTP_201_CREATED)
async def create_pipeline(
    body: PipelineCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project_access(db, body.project_uid, user, "pipeline:write")
    pipeline = await pipeline_service.create(db, body)
    await _notify(db, request, user, pipeline, "created")
    return pipeline


@router.get("/{pipeline_id}", response_model=PipelineResponse)
async def get_pipeline(
    pipeline_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load(db, pipeline_id, user, "pipeline:read")


@router.patch("/{pipeline_id}", response_model=PipelineResponse)
async def update_pipeline(
    pipeline_id: str,
    body: PipelineUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    pipeline = await _load(db, pipeline_id, user, "pipeline:write")
    changes = body.model_dump(exclude_unset=True)
    nodes_before = list(pipeline.nodes or [])
    edited = {k for k, v in changes.items() if k != "nodes" and getattr(pipeline, k) != v}
    pipeline = await pipeline_service.update(db, pipeline, body)
    node_changes, nodes_changed = _node_changes(nodes_before, pipeline.nodes or []) if "nodes" in changes else ([], False)
    if node_changes or edited:
        node = node_changes[0] if len(node_changes) == 1 else None
        await _notify(db, request, user, pipeline, "updated", node)
    elif nodes_changed:
        await _notify(db, request, user, pipeline, "updated", notify=False)
    return pipeline


@router.delete("/{pipeline_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_pipeline(
    pipeline_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    pipeline = await _load(db, pipeline_id, user, "pipeline:delete")
    gone = SimpleNamespace(id=pipeline.id, project_uid=pipeline.project_uid, name=pipeline.name)
    await pipeline_service.delete(db, pipeline)
    await _notify(db, request, user, gone, "deleted")
