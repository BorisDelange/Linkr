from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
from app.models.cohort import Cohort
from app.models.user import User
from app.schemas.cohort import CohortCreate, CohortMaterializeRequest, CohortResponse, CohortUpdate
from app.services import (
    cohort_access,
    cohort_service,
    data_source_service,
    notification_service,
    undo_service,
)

router = APIRouter(prefix="/cohorts", tags=["cohorts"])

async def _load(db: AsyncSession, cohort_id: str, user: User, permission: str) -> Cohort:
    cohort = await cohort_service.get(db, cohort_id)
    if cohort is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await cohort_access.require_owner_access(
        db, cohort.project_uid, cohort.owner_data_source_id, user, permission
    )
    return cohort


@router.get("", response_model=list[CohortResponse])
async def list_cohorts(
    project_uid: str | None = Query(default=None, alias="projectUid"),
    data_source_id: str | None = Query(default=None, alias="dataSourceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if project_uid is not None:
        await cohort_access.require_project_access(db, project_uid, user, "cohorts:read")
        return await cohort_service.list_for_project(db, project_uid)
    if data_source_id is not None:
        await cohort_access.require_database_access(db, data_source_id, user, "cohorts:read")
        return await cohort_service.list_for_database(db, data_source_id)
    return await cohort_service.list_for_user(db, user)


@router.post("", response_model=CohortResponse, status_code=status.HTTP_201_CREATED)
async def create_cohort(
    body: CohortCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if bool(body.project_uid) == bool(body.owner_data_source_id):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "a cohort belongs to exactly one project or one database",
        )
    await cohort_access.require_owner_access(
        db, body.project_uid, body.owner_data_source_id, user, "cohorts:write"
    )
    if body.owner_data_source_id:
        # A database's cohort runs against that database — never another one.
        body.data_source_id = body.owner_data_source_id
    cohort = await cohort_service.create(db, body)
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request), action="created",
        entity_type="cohort", entity_id=cohort.id, project_uid=cohort.project_uid, label=cohort.name,
        undo={"kind": "cohort", "op": "delete", "id": cohort.id},
    )
    return cohort


@router.get("/{cohort_id}", response_model=CohortResponse)
async def get_cohort(
    cohort_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load(db, cohort_id, user, "cohorts:read")


@router.patch("/{cohort_id}", response_model=CohortResponse)
async def update_cohort(
    cohort_id: str,
    body: CohortUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    cohort = await _load(db, cohort_id, user, "cohorts:write")
    if cohort.owner_data_source_id and "data_source_id" in body.model_fields_set:
        body.data_source_id = cohort.owner_data_source_id
    changed = set(body.model_dump(exclude_unset=True))
    before = undo_service.cohort_snapshot(cohort)
    cohort = await cohort_service.update(db, cohort, body)
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request), action="updated",
        entity_type="cohort", entity_id=cohort.id, project_uid=cohort.project_uid, label=cohort.name,
        undo={"kind": "cohort", "op": "restore", "id": cohort.id, "snapshot": before},
        notify=not notification_service.is_derived_only(changed),
    )
    return cohort


@router.delete("/{cohort_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_cohort(
    cohort_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    cohort = await _load(db, cohort_id, user, "cohorts:delete")
    project_uid, label = cohort.project_uid, cohort.name
    before = undo_service.cohort_snapshot(cohort)
    await cohort_service.delete(db, cohort)
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request), action="deleted",
        entity_type="cohort", entity_id=cohort_id, project_uid=project_uid, label=label,
        undo={"kind": "cohort", "op": "recreate", "id": cohort_id, "snapshot": before},
    )


async def _record_materialization(
    db: AsyncSession, request: Request, user: User, cohort: Cohort, action: str, count: int | None,
    before: dict,
) -> None:
    detail: dict = {"part": "materialization", "action": action, "name": {"en": ""}}
    if count is not None:
        detail["count"] = count
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request), action="updated",
        entity_type="cohort", entity_id=cohort.id, project_uid=cohort.project_uid, label=cohort.name,
        detail=detail, undo={"kind": "cohort", "op": "restore", "id": cohort.id, "snapshot": before},
    )


@router.post("/{cohort_id}/materialize", response_model=CohortResponse)
async def materialize_cohort(
    cohort_id: str,
    body: CohortMaterializeRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Freeze the cohort's membership: run its membership query on the database,
    whole (no row cap), and store the ids as its materialization — what a
    project's Patient data reads. Replaces an earlier snapshot."""
    cohort = await _load(db, cohort_id, user, "cohorts:write")
    # A database's cohort has no reader for a frozen membership: its derivations
    # recompute it. Event level spans several tables, with no single id.
    if not cohort.project_uid:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "only a project's cohort can be frozen")
    if cohort.level == "event":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "an event-level cohort cannot be frozen")
    source_id = body.data_source_id or cohort.data_source_id
    if not source_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "no database to run the cohort on")
    source = await data_source_service.get(db, source_id)
    if source is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Database not found")
    if source.workspace_id is not None:
        await check_workspace_permission(db, source.workspace_id, user, "databases:read")

    try:
        table = await data_source_service.query(db, source, body.membership_sql, arrow=True)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
    except Exception as e:  # noqa: BLE001 — surface SQL/connection errors to the client
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    if not {"id", "patient_id"} <= set(table.column_names):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "the membership query must return `id` and `patient_id`"
        )

    materialization = cohort_service.build_materialization(
        cohort.level, table.column("id").to_pylist(), table.column("patient_id").to_pylist(),
        datetime.now(timezone.utc),
    )
    before = undo_service.cohort_snapshot(cohort)
    cohort = await cohort_service.update(db, cohort, CohortUpdate(
        materialization=materialization, result_count=materialization["count"],
    ))
    await _record_materialization(db, request, user, cohort, "created", materialization["count"], before)
    return cohort


@router.delete("/{cohort_id}/materialization", response_model=CohortResponse)
async def clear_materialization(
    cohort_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Drop the frozen membership: the cohort's readers go back to its live definition."""
    cohort = await _load(db, cohort_id, user, "cohorts:write")
    if cohort.materialization is None:
        return cohort
    before = undo_service.cohort_snapshot(cohort)
    cohort = await cohort_service.update(db, cohort, CohortUpdate(materialization=None))
    await _record_materialization(db, request, user, cohort, "deleted", None, before)
    return cohort
