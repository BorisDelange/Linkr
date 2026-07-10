from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.permissions import require_global_permission
from app.models.user import User
from app.schemas.organization import (
    OrganizationCreate,
    OrganizationResponse,
    OrganizationUpdate,
)
from app.services import organization_service

router = APIRouter(prefix="/organizations", tags=["organizations"])


@router.get("", response_model=list[OrganizationResponse])
async def list_organizations(
    _user: User = Depends(require_global_permission("organizations:read")),
    db: AsyncSession = Depends(get_db),
):
    return await organization_service.list_all(db)


@router.post("", response_model=OrganizationResponse, status_code=status.HTTP_201_CREATED)
async def create_organization(
    body: OrganizationCreate,
    _user: User = Depends(require_global_permission("organizations:write")),
    db: AsyncSession = Depends(get_db),
):
    return await organization_service.create(db, body)


@router.get("/{org_id}", response_model=OrganizationResponse)
async def get_organization(
    org_id: str,
    _user: User = Depends(require_global_permission("organizations:read")),
    db: AsyncSession = Depends(get_db),
):
    org = await organization_service.get(db, org_id)
    if org is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return org


@router.patch("/{org_id}", response_model=OrganizationResponse)
async def update_organization(
    org_id: str,
    body: OrganizationUpdate,
    _user: User = Depends(require_global_permission("organizations:write")),
    db: AsyncSession = Depends(get_db),
):
    org = await organization_service.get(db, org_id)
    if org is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return await organization_service.update(db, org, body)


@router.delete("/{org_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_organization(
    org_id: str,
    _user: User = Depends(require_global_permission("organizations:delete")),
    db: AsyncSession = Depends(get_db),
):
    org = await organization_service.get(db, org_id)
    if org is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    await organization_service.delete(db, org)
