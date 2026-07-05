from datetime import datetime

from app.schemas.base import CamelModel


class OrganizationCreate(CamelModel):
    id: str | None = None  # client supplies crypto.randomUUID()
    name: str
    type: str | None = None
    location: str | None = None
    country: str | None = None
    website: str | None = None
    email: str | None = None
    custom_type: str | None = None
    reference_id: str | None = None
    custom_fields: dict[str, str] | None = None


class OrganizationUpdate(CamelModel):
    name: str | None = None
    type: str | None = None
    location: str | None = None
    country: str | None = None
    website: str | None = None
    email: str | None = None
    custom_type: str | None = None
    reference_id: str | None = None
    custom_fields: dict[str, str] | None = None


class OrganizationResponse(CamelModel):
    id: str
    name: str
    type: str | None = None
    location: str | None = None
    country: str | None = None
    website: str | None = None
    email: str | None = None
    custom_type: str | None = None
    reference_id: str | None = None
    custom_fields: dict[str, str] | None = None
    created_at: datetime
    updated_at: datetime
