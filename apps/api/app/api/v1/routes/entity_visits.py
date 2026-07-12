from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_user
from app.models.user import User
from app.schemas.entity_visit import EntityVisitRecord, EntityVisitResponse
from app.services import entity_visit_service

router = APIRouter(prefix="/visits", tags=["visits"])


@router.get("", response_model=list[EntityVisitResponse])
async def list_visits(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await entity_visit_service.list_for_user(db, user.id)


@router.post("", response_model=EntityVisitResponse)
async def record_visit(
    body: EntityVisitRecord,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await entity_visit_service.record(db, user.id, body)
