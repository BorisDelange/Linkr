from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.core.permissions import check_workspace_permission
from app.models.concept_set import ConceptSet
from app.models.user import User
from app.schemas.concept_set import (
    ConceptSetCreate,
    ConceptSetDeleteBatch,
    ConceptSetResponse,
    ConceptSetUpdate,
)
from app.services import concept_set_service

router = APIRouter(prefix="/concept-sets", tags=["concept-sets"])


async def _load(db: AsyncSession, concept_set_id: str, user: User, permission: str) -> ConceptSet:
    concept_set = await concept_set_service.get(db, concept_set_id)
    if concept_set is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await check_workspace_permission(db, concept_set.workspace_id, user, permission)
    return concept_set


@router.get("", response_model=list[ConceptSetResponse])
async def list_concept_sets(
    workspace_id: str | None = Query(default=None, alias="workspaceId"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if workspace_id is not None:
        await check_workspace_permission(db, workspace_id, user, "concept-mapping:read")
        return await concept_set_service.list_for_workspace(db, workspace_id)
    sets = await concept_set_service.list_all(db)
    visible: list[ConceptSet] = []
    for cs in sets:
        try:
            await check_workspace_permission(db, cs.workspace_id, user, "concept-mapping:read")
            visible.append(cs)
        except HTTPException:
            continue
    return visible


@router.post("", response_model=ConceptSetResponse, status_code=status.HTTP_201_CREATED)
async def create_concept_set(
    body: ConceptSetCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await check_workspace_permission(db, body.workspace_id, user, "concept-mapping:write")
    return await concept_set_service.create(db, body)


@router.post("/delete-batch", status_code=status.HTTP_204_NO_CONTENT)
async def delete_batch(
    body: ConceptSetDeleteBatch,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Authorize each set's workspace before deleting; silently skip unknown ids.
    deletable: list[str] = []
    for cid in body.ids:
        cs = await concept_set_service.get(db, cid)
        if cs is None:
            continue
        await check_workspace_permission(db, cs.workspace_id, user, "concept-mapping:delete")
        deletable.append(cid)
    await concept_set_service.delete_batch(db, deletable)


@router.get("/{concept_set_id}", response_model=ConceptSetResponse)
async def get_concept_set(
    concept_set_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load(db, concept_set_id, user, "concept-mapping:read")


@router.patch("/{concept_set_id}", response_model=ConceptSetResponse)
async def update_concept_set(
    concept_set_id: str,
    body: ConceptSetUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    concept_set = await _load(db, concept_set_id, user, "concept-mapping:write")
    return await concept_set_service.update(db, concept_set, body)


@router.delete("/{concept_set_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_concept_set(
    concept_set_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    concept_set = await _load(db, concept_set_id, user, "concept-mapping:delete")
    await concept_set_service.delete(db, concept_set)
