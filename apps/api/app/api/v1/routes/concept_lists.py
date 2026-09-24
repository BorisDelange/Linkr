from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_project_permission
from app.models.concept_list import ConceptList
from app.models.project import Project
from app.models.user import User
from app.schemas.concept_list import (
    ConceptListCreate,
    ConceptListResponse,
    ConceptListUpdate,
)
from app.services import concept_list_service, notification_service

router = APIRouter(prefix="/concept-lists", tags=["concept-lists"])


async def _require_project_access(
    db: AsyncSession, project_uid: str, user: User, permission: str
) -> None:
    """Concept-list access derives from the owning project, gated on the atomic
    `concepts:*` permission (read to browse, write/delete to author lists)."""
    project = await db.get(Project, project_uid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    await check_project_permission(db, project, user, permission)


async def _load(
    db: AsyncSession, concept_list_id: str, user: User, permission: str
) -> ConceptList:
    concept_list = await concept_list_service.get(db, concept_list_id)
    if concept_list is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _require_project_access(db, concept_list.project_uid, user, permission)
    return concept_list


async def _notify(db: AsyncSession, request: Request, user: User, action: str, concept_list: ConceptList) -> None:
    await notification_service.record_change(
        db, user=user, source=notification_service.client_source(request), action=action,
        entity_type="concept_list", entity_id=concept_list.id, project_uid=concept_list.project_uid,
        label=concept_list.name,
    )


@router.get("", response_model=list[ConceptListResponse])
async def list_concept_lists(
    project_uid: str | None = Query(default=None, alias="projectUid"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if project_uid is not None:
        await _require_project_access(db, project_uid, user, "concepts:read")
        return await concept_list_service.list_for_project(db, project_uid)
    return await concept_list_service.list_for_user(db, user)


@router.post("", response_model=ConceptListResponse, status_code=status.HTTP_201_CREATED)
async def create_concept_list(
    body: ConceptListCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_project_access(db, body.project_uid, user, "concepts:write")
    created = await concept_list_service.create(db, body)
    await _notify(db, request, user, "created", created)
    return created


@router.get("/{concept_list_id}", response_model=ConceptListResponse)
async def get_concept_list(
    concept_list_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load(db, concept_list_id, user, "concepts:read")


@router.patch("/{concept_list_id}", response_model=ConceptListResponse)
async def update_concept_list(
    concept_list_id: str,
    body: ConceptListUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    concept_list = await _load(db, concept_list_id, user, "concepts:write")
    updated = await concept_list_service.update(db, concept_list, body)
    await _notify(db, request, user, "updated", updated)
    return updated


@router.delete("/{concept_list_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_concept_list(
    concept_list_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    concept_list = await _load(db, concept_list_id, user, "concepts:delete")
    await _notify(db, request, user, "deleted", concept_list)
    await concept_list_service.delete(db, concept_list)
